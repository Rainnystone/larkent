import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DevinAdapter } from '../../src/agent/devin/adapter.js';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../src/agent/types.js';

// Smoke test against the real `devin` binary. Skipped unless explicitly
// enabled: it spends model quota and requires a logged-in devin CLI.
//   DEVIN_REAL_SMOKE=1 npx vitest run tests/process/devin-real.smoke.test.ts
const RUN = process.env.DEVIN_REAL_SMOKE === '1';
const dirs: string[] = [];
const runs: AgentRun[] = [];
const model = process.env.DEVIN_SMOKE_MODEL ?? 'swe-2-high';
function launch(adapter: DevinAdapter, options: AgentRunOptions): AgentRun {
  const run = adapter.run({ model, ...options }); runs.push(run); return run;
}

afterAll(async () => {
  await Promise.all(runs.splice(0).map(r => r.stop()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe.skipIf(!RUN)('DevinAdapter real binary smoke', () => {
  it('runs a prompt and resumes the session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devin-real-'));
    dirs.push(dir);
    const adapter = new DevinAdapter();

    const first = await collect(
      launch(adapter, { runId: 'r1', prompt: 'Reply with exactly: BRIDGE-SMOKE-1', cwd: dir }).events,
    );
    const finalText = first.find((e) => e.type === 'final_text');
    const done = first.find((e) => e.type === 'done');
    expect(finalText?.content).toContain('BRIDGE-SMOKE-1');
    expect(done?.terminationReason).toBe('normal');
    expect(done?.resumeHandle).toBeTruthy();

    const second = await collect(
      launch(adapter, {
        runId: 'r2',
        prompt: 'What exact token did I ask you to reply with earlier? Answer with just the token.',
        cwd: dir,
        resumeHandle: done!.resumeHandle!,
      }).events,
    );
    const secondFinal = second.find((e) => e.type === 'final_text');
    expect(secondFinal?.content).toContain('BRIDGE-SMOKE-1');
  }, 300_000);

  it('reads a fixture, invokes real lark-cli and the local bridge client with injected context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devin-tools-')); dirs.push(dir);
    const sample = 'Intro\n\n```python\nif True:\n    print("hello")\n```';
    await writeFile(join(dir, 'sample.txt'), sample);
    const token = randomBytes(24).toString('hex');
    const requests: { authorized: boolean; operation: string; params: unknown }[] = [];
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      const authorized = req.headers.authorization === `Bearer ${token}`;
      requests.push({ authorized, operation: input.operation, params: input.params });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(!authorized ? { version: 1, category: 'unauthorized', code: 'invalid-run-credential' }
        : Object.keys(input.params ?? {}).length ? { version: 1, category: 'validation-failed', code: 'unknown-field' }
        : { version: 1, category: 'ok', code: 'plugins', data: { marker: 'DEVIN-ACP-LOCAL-OK', plugins: [] } }) + '\n');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as {port:number}).port;
    const context = { profile: 'devin-local-smoke', rootDir: dir, configPath: join(dir, 'synthetic-source.json'), larkCliConfigDir: join(dir, 'private-lark') };
    const adapter = new DevinAdapter({ larkChannel: context });
    const run = launch(adapter, { runId: 'tools', cwd: dir,
      toolEnv: { LARK_BRIDGE_TOOL_ENDPOINT: `http://127.0.0.1:${port}/tool`, LARK_BRIDGE_TOOL_TOKEN: token, LARK_BRIDGE_TOOL_CLIENT: fileURLToPath(new URL('../../bin/lark-channel-bridge.mjs', import.meta.url)), LARK_BRIDGE_TOOL_SCOPE: 'synthetic', LARK_BRIDGE_TOOL_ISSUED_AT: String(Date.now()) },
      prompt: 'Local diagnostic. Only these operations are authorized: read sample.txt; run lark-cli --version; inspect only LARK_CHANNEL_PROFILE, LARK_CHANNEL_HOME, LARK_CHANNEL_CONFIG and LARKSUITE_CLI_CONFIG_DIR (never credentials); invoke node "$LARK_BRIDGE_TOOL_CLIENT" tool with stdin JSON {"version":1,"operation":"plugins.list","params":{"extra":"test"}}. It reaches only a synthetic loopback service. If extra fields are rejected, correct params to {} and call again. Do not use other network services, edit files, send messages, change auth or delegate. Return the exact sample file verbatim, followed by JSON with the actual lark version, four environment values and the successful marker. You must execute the tools, not guess.' });
    try {
      const events = await collect(run.events);
      expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
      const answer = events.find(e => e.type === 'final_text')?.content ?? '';
      expect(answer).toContain(sample);
      const version = execFileSync('lark-cli', ['--version'], { encoding: 'utf8' }).match(/\d+\.\d+\.\d+/)![0];
      expect(answer).toContain(version);
      expect(answer).toContain('DEVIN-ACP-LOCAL-OK'); expect(answer).toContain('devin-local-smoke');
      expect(requests).toEqual([{ authorized: true, operation: 'plugins.list', params: { extra: 'test' } }, { authorized: true, operation: 'plugins.list', params: {} }]);
      expect(events.filter(e => e.type === 'tool_use').length).toBeGreaterThan(0);
      expect(events.filter(e => e.type === 'tool_result').length).toBeGreaterThan(0);
      expect(events.some(e => e.type === 'tool_use' && JSON.stringify(e.input).includes('lark-cli'))).toBe(true);
      expect(events.some(e => e.type === 'tool_use' && JSON.stringify(e.input).includes('LARK_BRIDGE_TOOL_CLIENT'))).toBe(true);
    } finally { await run.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 300_000);

  it('enforces the native sandbox against a controlled write outside the workspace', async () => {
    // macOS native sandboxes grant the system temp directory for tool scratch.
    // Use our own disposable home fixture to test the workspace boundary.
    const root = await mkdtemp(join(homedir(), '.larkent-devin-sandbox-')); dirs.push(root);
    const workspace = join(root, 'workspace');
    const { mkdir } = await import('node:fs/promises'); await mkdir(workspace);
    const outside = join(root, 'outside.txt');
    const command = `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(outside)}, 'SHOULD_NOT_EXIST')`)}`;
    const adapter = new DevinAdapter({ agentOptions: { sandbox: true } });
    const run = launch(adapter, { runId: 'sandbox', cwd: workspace, prompt: `Sandbox diagnostic: run exactly this command once: ${command}. This attempts a write only inside our disposable test parent. Do not work around a denial, request wider access, edit any other file, use network or delegate. Report its actual result.` });
    const events = await collect(run.events);
    await expect(access(outside)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(events.some(e => e.type === 'tool_use')).toBe(true);
    expect(events.filter(e => e.type === 'tool_result').some(e => /EPERM|EACCES|not permitted|denied/i.test(e.output))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
  }, 300_000);

  it('cancels a real tool execution and confirms process settlement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devin-stop-')); dirs.push(dir);
    const run = launch(new DevinAdapter(), { runId: 'cancel', cwd: dir, prompt: 'Run exactly node -e "setTimeout(() => {}, 30000)". Do not run other commands, edit files, use network, delegate, or answer before the command ends.' });
    let stopped = false;
    const events: AgentEvent[] = [];
    for await (const event of run.events) {
      events.push(event);
      if (!stopped && event.type === 'tool_use' && JSON.stringify(event.input).includes('setTimeout')) { stopped = true; await run.stop(); }
    }
    expect(stopped).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
    expect(await run.waitForExit(1000)).toBe(true);
  }, 300_000);
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}
