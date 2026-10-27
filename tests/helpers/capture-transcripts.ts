/**
 * D03a: capture real protocol transcripts from the locally installed,
 * logged-in agent CLIs. Opt-in manual tooling; never run by CI.
 *
 *   pnpm exec tsx tests/helpers/capture-transcripts.ts <kind> <scenario> [outDir]
 *   pnpm exec tsx tests/helpers/capture-transcripts.ts --all [outDir]
 *
 * kind: claude | codex | kimi | grok | cursor | antigravity | devin
 * scenario: answer-only | narration-tool-answer | two-tools | long-tool |
 *           stop-mid-answer | error-unknown-model
 *
 * JSONL kinds are spawned with the adapter's own argv builder and the same
 * env/stdin wiring as src/agent/<kind>/adapter.ts run(), so flags match
 * production; raw stdout lines are teed to the fixture file. Devin runs the
 * real DevinAdapter and tees the ACP session-update notifications the
 * DevinTranscriptTranslator receives (prototype seam, no src/ changes).
 *
 * Record format (one JSON object per line):
 *   header:  {"transcript":1,"kind","cliVersion","capturedAt","scenario","command","notes"}
 *   stdout:  {"t":<ms since spawn>,"line":<raw stdout line>}
 *   stderr:  {"t":<ms>,"stderr":<raw stderr line>}
 *   devin:   {"t":<ms>,"update":<ACP session/update params.update>}
 *   harness: {"t":<ms>,"note":<e.g. "first text event", "SIGTERM sent">}
 *   exit:    {"t":<ms>,"exit":{"code":<n|null>,"signal":<name|null>}}
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { execSync } from 'node:child_process';
import { spawnProcess, agentSpawnEnv } from '../../src/platform/spawn';
import { signalProcessTree } from '../../src/platform/process-tree';
import { buildLarkChannelEnv } from '../../src/agent/lark-channel-env';
import { buildBridgeSystemPrompt, prefixBridgeSystemPrompt } from '../../src/agent/bridge-system-prompt';
import { buildClaudeArgs } from '../../src/agent/claude/argv';
import { CLAUDE_DEFAULT_PERMISSION_MODE } from '../../src/agent/claude/options';
import { buildCodexArgs } from '../../src/agent/codex/argv';
import { buildKimiArgs } from '../../src/agent/kimi/argv';
import { buildGrokArgs } from '../../src/agent/grok/argv';
import { buildCursorArgs } from '../../src/agent/cursor/argv';
import { buildAntigravityArgs } from '../../src/agent/antigravity/argv';
import { wrapParsedTranslator, type JsonlTranslator } from '../../src/agent/runner/jsonl-cli-runner';
import { ClaudeStreamTranslator } from '../../src/agent/claude/stream-json';
import { CodexJsonlTranslator } from '../../src/agent/codex/jsonl';
import { KimiJsonlTranslator } from '../../src/agent/kimi/jsonl';
import { GrokJsonlTranslator } from '../../src/agent/grok/jsonl';
import { CursorJsonlTranslator } from '../../src/agent/cursor/jsonl';
import { AntigravityJsonlTranslator } from '../../src/agent/antigravity/jsonl';
import { DevinAdapter } from '../../src/agent/devin/adapter';
import { DevinTranscriptTranslator } from '../../src/agent/devin/transcript';
import type { AgentEvent } from '../../src/agent/types';

type Kind = 'claude' | 'codex' | 'kimi' | 'grok' | 'cursor' | 'antigravity' | 'devin';
type Scenario = 'answer-only' | 'narration-tool-answer' | 'two-tools' | 'long-tool' | 'stop-mid-answer' | 'error-unknown-model';

const KINDS: Kind[] = ['claude', 'codex', 'kimi', 'grok', 'cursor', 'antigravity', 'devin'];
const SCENARIOS: Scenario[] = ['answer-only', 'narration-tool-answer', 'two-tools', 'long-tool', 'stop-mid-answer', 'error-unknown-model'];
const BAD_MODEL = 'lark-nonexistent-model-0';
const STOP_GRACE_MS = 5000;
const FIRST_TEXT_STOP_DELAY_MS = 800;

const BINARY: Record<Kind, string> = {
  claude: 'claude', codex: 'codex', kimi: 'kimi', grok: 'grok',
  cursor: 'cursor-agent', antigravity: 'agy', devin: 'devin',
};

const PROMPTS: Record<Scenario, string> = {
  'answer-only': 'Reply with exactly: TRANSCRIPT-OK',
  'narration-tool-answer': 'First say one sentence about what you will do. Then use your shell tool to run `echo hello`. Then report the output.',
  'two-tools': 'Run `echo one` and then `echo two` as two separate shell tool calls. Then say DONE.',
  'long-tool': 'Use your shell tool to run `sleep 45 && echo done`. Then say DONE.',
  'stop-mid-answer': 'Count from one to three hundred in words, one number per line. Do not use any tools.',
  'error-unknown-model': 'Reply with exactly: TRANSCRIPT-OK',
};

// Cursor's default model spends minutes thinking even on trivial prompts.
const KIND_TIMEOUT_FACTOR: Partial<Record<Kind, number>> = { cursor: 3 };
const TIMEOUT_MS: Record<Scenario, number> = {
  'answer-only': 120_000,
  'narration-tool-answer': 180_000,
  'two-tools': 180_000,
  'long-tool': 200_000,
  'stop-mid-answer': 120_000,
  'error-unknown-model': 90_000,
};

interface Spec { argv: string[]; stdin?: string; env: NodeJS.ProcessEnv; cleanup?: () => void; command: string }

/** Render argv for the header with prompts, secret-ish values and temp paths masked. */
function maskCommand(binary: string, argv: string[], replacements: [string, string][]): string {
  const masked = argv.map(arg => {
    for (const [raw, mask] of replacements) if (raw && arg.includes(raw)) return mask;
    return arg;
  });
  return [binary, ...masked].map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return agentSpawnEnv(process.env, { ...buildLarkChannelEnv(), ...extra });
}

function buildSpec(kind: Exclude<Kind, 'devin'>, cwd: string, prompt: string, model?: string): Spec {
  const b = BINARY[kind];
  switch (kind) {
    case 'claude': {
      const dir = mkdtempSync(join(tmpdir(), 'lark-claude-cap-'));
      const systemPromptFile = join(dir, 'append-system-prompt.md');
      writeFileSync(systemPromptFile, buildBridgeSystemPrompt(undefined, 'default'), 'utf8');
      const argv = buildClaudeArgs({ systemPromptFile, permissionMode: CLAUDE_DEFAULT_PERMISSION_MODE, ...(model ? { model } : {}) });
      return { argv, stdin: prompt, env: baseEnv(), cleanup: () => rmSync(dir, { recursive: true, force: true }), command: maskCommand(b, argv, [[dir, '<TMP>']]) };
    }
    case 'codex': {
      const argv = buildCodexArgs({ cwd, sandbox: 'danger-full-access', ...(model ? { model } : {}) });
      return { argv, stdin: prefixBridgeSystemPrompt(prompt, undefined, 'default'), env: baseEnv(), command: maskCommand(b, argv, [[cwd, '<CWD>']]) };
    }
    case 'kimi': {
      const prefixed = prefixBridgeSystemPrompt(prompt, undefined, 'default');
      const argv = buildKimiArgs({ prompt: prefixed, ...(model ? { model } : {}) });
      return { argv, env: baseEnv(), command: maskCommand(b, argv, [[prefixed, '<PROMPT>']]) };
    }
    case 'grok': {
      const dir = mkdtempSync(join(tmpdir(), 'lark-grok-cap-'));
      const promptFile = join(dir, 'prompt.md');
      writeFileSync(promptFile, prompt, 'utf8');
      const rules = buildBridgeSystemPrompt(undefined, 'default');
      const argv = buildGrokArgs({ promptFile, rules, ...(model ? { model } : {}) });
      return {
        argv, env: baseEnv({ NO_COLOR: undefined, GROK_DISABLE_AUTOUPDATER: '1' }),
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
        command: maskCommand(b, argv, [[dir, '<TMP>'], [rules, '<RULES>']]),
      };
    }
    case 'cursor': {
      const prefixed = prefixBridgeSystemPrompt(prompt, undefined, 'default');
      const argv = buildCursorArgs({ prompt: prefixed, ...(model ? { model } : {}) });
      return { argv, env: baseEnv(), command: maskCommand(b, argv, [[prefixed, '<PROMPT>']]) };
    }
    case 'antigravity': {
      const prefixed = prefixBridgeSystemPrompt(prompt, undefined, 'default');
      const argv = buildAntigravityArgs({ prompt: prefixed, ...(model ? { model } : {}) });
      return { argv, env: baseEnv(), command: maskCommand(b, argv, [[prefixed, '<PROMPT>']]) };
    }
  }
}

function newTranslator(kind: Exclude<Kind, 'devin'>): JsonlTranslator {
  switch (kind) {
    case 'claude': return wrapParsedTranslator(new ClaudeStreamTranslator(), 'claude');
    case 'codex': return wrapParsedTranslator(new CodexJsonlTranslator(), 'codex');
    case 'kimi': return wrapParsedTranslator(new KimiJsonlTranslator(), 'kimi');
    case 'grok': return wrapParsedTranslator(new GrokJsonlTranslator(), 'grok');
    case 'cursor': return wrapParsedTranslator(new CursorJsonlTranslator(), 'cursor');
    case 'antigravity': return wrapParsedTranslator(new AntigravityJsonlTranslator(), 'agy');
  }
}

type Rec = Record<string, unknown>;

async function captureJsonl(kind: Exclude<Kind, 'devin'>, scenario: Scenario, cwd: string): Promise<{ records: Rec[]; command: string }> {
  const model = scenario === 'error-unknown-model' ? BAD_MODEL : undefined;
  const spec = buildSpec(kind, cwd, PROMPTS[scenario], model);
  const records: Rec[] = [];
  const timeoutMs = TIMEOUT_MS[scenario] * (KIND_TIMEOUT_FACTOR[kind] ?? 1);
  const t0 = Date.now();
  const t = () => Date.now() - t0;
  const note = (text: string) => records.push({ t: t(), note: text });

  const translator = newTranslator(kind);
  const events: AgentEvent[] = [];
  const child = spawnProcess(BINARY[kind], spec.argv, { cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error('piped stdio required');
  const childStdin = child.stdin, childStdout = child.stdout, childStderr = child.stderr;
  note(`spawned pid=${child.pid ?? 'null'}`);
  childStderr.on('data', (chunk: Buffer) => records.push({ t: t(), stderr: chunk.toString('utf8').replace(/\n$/, '') }));

  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  const exitP = new Promise<void>(resolve => {
    child.once('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; resolve(); });
  });

  const stopWanted = scenario === 'stop-mid-answer';
  let stopSent = false;
  const sendStop = () => {
    if (stopSent || exited) return;
    stopSent = true;
    note('SIGTERM sent to process group (production stop path)');
    signalProcessTree(child, 'SIGTERM', true);
    setTimeout(() => {
      if (!exited) {
        note('SIGKILL sent after stop grace');
        signalProcessTree(child, 'SIGKILL', true);
      }
    }, STOP_GRACE_MS).unref();
  };
  const hardTimeout = setTimeout(() => {
    note(`hard timeout ${timeoutMs}ms reached; stopping`);
    sendStop();
  }, timeoutMs);
  hardTimeout.unref();

  const done = new Promise<void>(resolve => {
    const decoder = new StringDecoder('utf8');
    let buf = '';
    childStdout.on('data', (chunk: Buffer) => {
      buf += decoder.write(chunk);
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (!line) continue;
        records.push({ t: t(), line });
        for (const event of translator.translate(line)) {
          events.push(event);
          if (stopWanted && !stopSent && (event.type === 'text' || event.type === 'final_text' || event.type === 'thinking')) {
            note(`first ${event.type} event`);
            setTimeout(sendStop, FIRST_TEXT_STOP_DELAY_MS);
          }
        }
      }
    });
    const finish = () => {
      buf += decoder.end();
      const tail = buf.trim();
      if (tail) {
        records.push({ t: t(), line: tail });
        for (const event of translator.translate(tail)) events.push(event);
      }
      resolve();
    };
    childStdout.once('end', finish);
    childStdout.once('close', finish);
  });

  childStdin.on('error', () => {});
  childStdin.end(spec.stdin ?? '', 'utf8');

  await done;
  await exitP;
  spec.cleanup?.();
  // Drain any trailing exit/settlement records.
  records.push({ t: t(), exit: { code: exitCode, signal: exitSignal } });
  for (const event of events.slice(-3)) note(`translator tail event: ${JSON.stringify(event).slice(0, 200)}`);
  clearTimeout(hardTimeout);
  return { records, command: spec.command };
}

async function captureDevin(scenario: Scenario, cwd: string): Promise<Rec[]> {
  const records: Rec[] = [];
  const timeoutMs = TIMEOUT_MS[scenario] * (KIND_TIMEOUT_FACTOR.devin ?? 1);
  const t0 = Date.now();
  const t = () => Date.now() - t0;
  const note = (text: string) => records.push({ t: t(), note: text });

  // Tee the ACP session-update objects the transcript translator receives.
  const original = DevinTranscriptTranslator.prototype.translate;
  DevinTranscriptTranslator.prototype.translate = function (value: unknown, replay = false) {
    records.push({ t: t(), update: value });
    return original.call(this, value, replay);
  };

  const adapter = new DevinAdapter({ binary: 'devin' });
  const run = adapter.run({
    runId: `capture-devin-${scenario}`,
    cwd,
    prompt: PROMPTS[scenario],
    ...(scenario === 'error-unknown-model' ? { model: BAD_MODEL } : {}),
    stopGraceMs: STOP_GRACE_MS,
  });
  note(`spawned pid=${run.pid ?? 'null'} (real DevinAdapter.run, translator.translate teed)`);

  const stopWanted = scenario === 'stop-mid-answer';
  let stopSent = false;
  // The first 'system' event is the session-start resumeHandle marker pushed
  // by settlement, not answer text; per-chunk markers come after it.
  let systemEvents = 0;
  let firstTextAt: number | undefined;
  const hardTimeout = setTimeout(() => {
    note(`hard timeout ${timeoutMs}ms reached; stopping`);
    void run.stop();
  }, TIMEOUT_MS[scenario] * (KIND_TIMEOUT_FACTOR.devin ?? 1));
  hardTimeout.unref();

  try {
    for await (const event of run.events) {
      if (stopWanted && !stopSent && (event.type === 'text' || event.type === 'final_text' || event.type === 'thinking' || (event.type === 'system' && ++systemEvents >= 2))) {
        // Devin emits a 'system' marker per agent_message_chunk; the first one
        // is the first answer text arriving.
        firstTextAt ??= t();
        stopSent = true;
        note(`first ${event.type} event; scheduling production stop (session/cancel + SIGTERM)`);
        setTimeout(() => { note('run.stop() called'); void run.stop(); }, FIRST_TEXT_STOP_DELAY_MS).unref();
      }
      if (event.type === 'done' || event.type === 'error') note(`terminal event: ${JSON.stringify(event).slice(0, 300)}`);
    }
  } catch (error) {
    note(`events iterator threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    DevinTranscriptTranslator.prototype.translate = original;
    clearTimeout(hardTimeout);
    if (!await run.waitForExit(10_000)) await run.stop();
  }
  const stderr = run.stderrSnapshot;
  if (stderr) records.push({ t: t(), stderr });
  records.push({ t: t(), exit: { code: run.exit ?? null, signal: run.signal ?? null } });
  return records;
}

/* ---------- sanitization ---------- */

function makeSanitizer(kind: Kind, cwd: string) {
  const sessionMap = new Map<string, string>();
  const toolMap = new Map<string, string>();
  const idMap = new Map<string, string>();
  const tokenMap = new Map<string, string>();
  const home = homedir();
  const user = userInfo().username;
  const allMaps = () => [sessionMap, toolMap, idMap, tokenMap];
  const mapped = (map: Map<string, string>, prefix: string, value: string) => {
    for (const m of allMaps()) { const hit = m.get(value); if (hit) return hit; }
    const out = `<${prefix}_${map.size + 1}>`;
    map.set(value, out);
    return out;
  };
  const uuidRe = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
  const scrubString = (s: string): string => {
    let out = s;
    if (cwd) {
      out = out.split(cwd).join('<CWD>').split(`/private${cwd}`).join('<CWD>');
      // Claude mangles cwd into a project key (-private-var-folders-…-capture-x).
      out = out.split(`/private${cwd}`.replaceAll('/', '-')).join('-<CWD>');
      out = out.split(cwd.replaceAll('/', '-')).join('-<CWD>');
    }
    out = out.split(`/private${tmpdir()}`).join('<TMP>').split(tmpdir()).join('<TMP>');
    out = out.split(home).join('<HOME>').split(`/Users/${user}`).join('<HOME>');
    out = out.split(user).join('<USER>');
    out = out.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<EMAIL>');
    out = out.replace(/\b(ou|oc|om|cli|on)_[A-Za-z0-9]+\b/g, m => mapped(idMap, 'ID', m));
    out = out.replace(/\b(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/g, m => mapped(tokenMap, 'TOKEN', m));
    // Account-named hosts (e.g. <account>.workers.dev MCP endpoints) and any
    // email local-part reappearing outside a full address (subdomains, ids).
    out = out.replace(/\b[\w-]+\.workers\.dev\b/g, '<ACCOUNT>.workers.dev');
    out = out.replace(uuidRe, m => mapped(idMap, 'UUID', m));
    // Residual opaque runs: >=16 hex chars (request ids), >=40 base64-ish
    // (signatures/tokens). Placeholders already contain '<' so they are safe.
    out = out.replace(/\b[0-9a-fA-F]{16,}\b/g, m => mapped(tokenMap, 'HEX', m));
    out = out.replace(/[A-Za-z0-9+/=_-]{40,}/g, m => (m.includes('<') ? m : mapped(tokenMap, 'TOK', m)));
    return out;
  };
  const scrubDeep = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string') {
      const k = key ?? '';
      if (/^(session_?id|sessionId|conversation_?id|conversationId|thread_?id|threadId|resumeHandle|resume_handle)$/i.test(k) && value.length > 6) return mapped(sessionMap, 'SESSION', value);
      if (/tool.*id|toolCallId|tool_use_id|call_?id|item_?id/i.test(k) && value.length > 4) return mapped(toolMap, 'TOOL', value);
      if (/^(id|.*_id|.*Id)$/.test(k) && value.length > 8 && !/^[a-z-]+$/.test(value)) return mapped(idMap, 'ID', value);
      if (/token|secret|api_?key|authorization|signature/i.test(k) && value.length > 8) return mapped(tokenMap, 'TOKEN', value);
      return scrubString(value);
    }
    if (Array.isArray(value)) return value.map(v => scrubDeep(v));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, k);
      return out;
    }
    return value;
  };
  // Local-environment inventory that must not leak into fixtures: personal
  // tool/skill/plugin/agent lists, hook-injected text, socket paths.
  const ENV_KEYS = new Set([
    'tools', 'mcp_servers', 'mcpServers', 'slash_commands', 'skills', 'plugins',
    'agents', 'memory_paths', 'messaging_socket_path', 'commands',
    'available_commands', 'hooks', 'marketplace_plugins', 'enabled_plugins',
  ]);
  const redactEnv = (kind: Kind, inner: Record<string, unknown>): void => {
    const mask = (d: Record<string, unknown>, keys: ReadonlySet<string>) => {
      for (const k of Object.keys(d)) {
        if (keys.has(k)) d[k] = Array.isArray(d[k]) ? ['<REDACTED_LOCAL_ENV>'] : '<REDACTED_LOCAL_ENV>';
      }
    };
    const t = inner.type, st = inner.subtype, ev = inner.event;
    if (kind === 'claude') {
      if (t === 'system' && st === 'init') mask(inner, ENV_KEYS);
      if (t === 'system' && typeof st === 'string' && st.startsWith('hook')) mask(inner, new Set(['output', 'stdout', 'stderr']));
      if (t === 'system' && st === 'commands_changed') mask(inner, new Set(['commands']));
    } else if (kind === 'grok') {
      if (t === 'available_commands') mask(inner, new Set(['commands', 'skills', 'plugins', 'slash_commands']));
    } else {
      if ((t === 'system' && st === 'init') || ev === 'init') {
        mask(inner, ENV_KEYS);
        const nested = inner.init;
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
          mask(nested as Record<string, unknown>, ENV_KEYS);
        }
      }
      if (t === 'thread.started' || t === 'session.started') mask(inner, ENV_KEYS);
    }
  };
  const scrubLine = (raw: string): string => {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') redactEnv(kind, parsed);
      return JSON.stringify(scrubDeep(parsed));
    } catch {
      // Non-JSON line: UUIDs inside free text still get stable placeholders.
      return scrubString(raw).replace(uuidRe, m => mapped(idMap, 'UUID', m));
    }
  };
  return { scrubLine, scrubDeep };
}

/* ---------- driver ---------- */

function cliVersion(kind: Kind): string {
  try { return execSync(`${BINARY[kind]} --version`, { encoding: 'utf8', timeout: 15_000 }).trim().split('\n')[0] ?? ''; }
  catch { return 'unknown'; }
}

async function run(kind: Kind, scenario: Scenario, outDir: string): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), `capture-${kind}-`));
  try {
    const { records, command } = kind === 'devin'
      ? { records: await captureDevin(scenario, cwd), command: 'devin acp (ACP stdio; prompt via session/prompt)' }
      : await captureJsonl(kind, scenario, cwd);
    const header: Rec = {
      transcript: 1,
      kind,
      cliVersion: cliVersion(kind),
      capturedAt: new Date().toISOString().slice(0, 10),
      scenario,
      command,
      notes: 't = ms since spawn; run in fresh mkdtemp cwd',
    };
    const san = makeSanitizer(kind, cwd);
    const lines = [header, ...records].map(rec => {
      const copy = { ...rec } as Rec & { command?: string; line?: string; update?: unknown; stderr?: string };
      if (typeof copy.command === 'string') copy.command = san.scrubLine(copy.command).replaceAll(cwd, '<CWD>');
      if (typeof copy.line === 'string') copy.line = san.scrubLine(copy.line);
      if (typeof copy.stderr === 'string') copy.stderr = san.scrubLine(copy.stderr);
      if (copy.update !== undefined) copy.update = san.scrubDeep(copy.update);
      if (typeof copy.note === 'string') copy.note = san.scrubLine(copy.note);
      return JSON.stringify(copy);
    });
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, kind, `${scenario}.jsonl`);
    mkdirSync(join(outDir, kind), { recursive: true });
    writeFileSync(file, lines.join('\n') + '\n');
    return file;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const outDir = resolve(args[0] === '--all' ? (args[1] ?? 'tests/fixtures/transcripts') : (args[2] ?? 'tests/fixtures/transcripts'));

if (args[0] === '--all') {
  for (const kind of KINDS) for (const scenario of SCENARIOS) {
    console.log(`=== ${kind}/${scenario} ===`);
    try { console.log('wrote', await run(kind, scenario, outDir)); }
    catch (error) { console.error(`FAILED ${kind}/${scenario}:`, error); }
  }
} else {
  const [kind, scenario] = args as [Kind, Scenario];
  console.log('wrote', await run(kind, scenario, outDir));
}
