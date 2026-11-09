import { delimiter, join } from 'node:path';
import { writeScriptedJsonlExecutable, type ScriptedJsonlExecutable } from './fake-executable.js';

export const PIN_AGENT_KINDS = ['claude', 'codex', 'kimi', 'grok', 'cursor', 'antigravity', 'devin'] as const;
export type PinAgentKind = (typeof PIN_AGENT_KINDS)[number];

export interface JsonlScript {
  lines: unknown[];
  stderr?: string;
  exitCode?: number;
  hang?: boolean;
  readyPath?: string;
  releasePath?: string;
  recordAppendPath?: string;
  holdAfterLines?: boolean;
  closeStdoutAfterLines?: boolean;
  onSigterm?: { lines?: unknown[]; stderr?: string; exitCode?: number };
  /** Devin ACP fixture session id (legacy property name for shared controls). */
  exportSessionId?: string;
}

export type AgyScenario = 'success' | 'sticky-error' | 'interrupted-on-sigterm' | 'hold-for-kill' | 'exit-without-result';

export const AGY_STICKY_ERROR =
  'agent executor error: generating and executing: request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": Bad Gateway';

/**
 * agy 1.5.3 stream-json shapes from the 2026-11-09 captures
 * (round4 01-cli-capture-canonical-sticky, round5 agy-probe-1).
 */
export function agyScript(scenario: AgyScenario, conversationId: string, answer = PIN_ANSWER): JsonlScript {
  const step = (step_index: number, step_type: string, extra: Record<string, unknown> = {}) => ({
    event: 'step_update',
    step_update: { conversation_id: conversationId, step_index, state: 'DONE', step_type, ...extra },
  });
  const started = [
    { event: 'init', conversation_id: conversationId, init: { model: 'gemini-3.8-flash-low', cwd: '/tmp', tools: [] } },
    step(0, 'user_input'),
  ];
  const tool = step(1, 'tool', {
    state: 'ACTIVE', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'sleep 25' } },
  });
  const result = (fields: Record<string, unknown>) => ({ event: 'result', result: { conversation_id: conversationId, ...fields } });
  switch (scenario) {
    case 'success':
      return { lines: [...started, step(1, 'agent_response', { text_delta: answer }), result({ status: 'SUCCESS', response: answer })] };
    case 'sticky-error':
      // The resumed turn answered, yet agy still reports the earlier error.
      return { lines: [...started, step(1, 'agent_response', { text_delta: answer }),
        result({ status: 'ERROR', response: `${answer}\n`, error: AGY_STICKY_ERROR, finished_reason: 'error' })] };
    case 'interrupted-on-sigterm':
      return { lines: [...started, tool], holdAfterLines: true, onSigterm: {
        lines: [result({ status: 'ERROR', response: '', error: 'interrupted', finished_reason: 'interrupted' })],
        stderr: 'error: interrupted\n', exitCode: 1,
      } };
    case 'hold-for-kill':
      return { lines: [...started, tool], holdAfterLines: true };
    case 'exit-without-result':
      return { lines: started, stderr: 'agy exploded\n', exitCode: 1 };
    default: {
      const _never: never = scenario;
      throw new Error(`unhandled agy scenario: ${String(_never)}`);
    }
  }
}

export interface KindCliInstall {
  kind: PinAgentKind;
  fake: ScriptedJsonlExecutable;
  binaryName: string;
}

const PIN_SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PIN_THREAD = 'thread-pin-codex';
const PIN_KIMI_SESSION = 'session_pin_kimi';
const PIN_CURSOR_SESSION = 'c6b62c6f-7ead-4fd6-9922-e952131177ff';
const PIN_ANSWER = 'PINNED_ANSWER';
const PIN_ERROR = 'PINNED_ERROR';

const CURSOR_HELP = [
  'Usage: agent [options]',
  '  --output-format <fmt>',
  '  --approve-mcps',
  '  stream-json',
].join('\n');

export function pinAgentKind(kind: PinAgentKind): PinAgentKind {
  switch (kind) {
    case 'claude':
    case 'codex':
    case 'kimi':
    case 'grok':
    case 'cursor':
    case 'antigravity':
    case 'devin':
      return kind;
    default: {
      const _never: never = kind;
      throw new Error(`unhandled agent kind: ${String(_never)}`);
    }
  }
}

export function defaultBinaryName(kind: PinAgentKind): string {
  switch (kind) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'kimi':
      return 'kimi';
    case 'grok':
      return 'grok';
    case 'cursor':
      return 'cursor-agent';
    case 'antigravity':
      return 'agy';
    case 'devin':
      return 'devin';
    default: {
      const _never: never = kind;
      throw new Error(`unhandled agent kind: ${String(_never)}`);
    }
  }
}

export function envBinVarName(kind: PinAgentKind): string {
  switch (kind) {
    case 'claude':
      return 'LARK_CHANNEL_CLAUDE_BIN';
    case 'codex':
      return 'LARK_CHANNEL_CODEX_BIN';
    case 'kimi':
      return 'LARK_CHANNEL_KIMI_BIN';
    case 'grok':
      return 'LARK_CHANNEL_GROK_BIN';
    case 'cursor':
      return 'LARK_CHANNEL_CURSOR_BIN';
    case 'antigravity':
      return 'LARK_CHANNEL_ANTIGRAVITY_BIN';
    case 'devin':
      return 'LARK_CHANNEL_DEVIN_BIN';
    default: {
      const _never: never = kind;
      throw new Error(`unhandled agent kind: ${String(_never)}`);
    }
  }
}

export function adapterDisplayName(kind: PinAgentKind): string {
  switch (kind) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex CLI';
    case 'kimi':
      return 'Kimi Code';
    case 'grok':
      return 'Grok Build';
    case 'cursor':
      return 'Cursor CLI';
    case 'antigravity':
      return 'Antigravity CLI';
    case 'devin':
      return 'Devin CLI';
    default: {
      const _never: never = kind;
      throw new Error(`unhandled agent kind: ${String(_never)}`);
    }
  }
}

export function jsonlScript(kind: PinAgentKind, scenario: 'success' | 'error'): JsonlScript {
  if (scenario === 'error') {
    return { lines: [], stderr: `${PIN_ERROR}\n`, exitCode: 1 };
  }
  switch (kind) {
    case 'claude':
      return {
        lines: [
          {
            type: 'system',
            subtype: 'init',
            session_id: PIN_SESSION,
            cwd: '/tmp',
            model: 'claude-sonnet-4-6',
          },
          {
            type: 'assistant',
            message: { content: [{ type: 'text', text: PIN_ANSWER }] },
          },
          { type: 'result', session_id: PIN_SESSION },
        ],
      };
    case 'codex':
      return {
        lines: [
          { type: 'thread.started', thread_id: PIN_THREAD },
          { type: 'agent_message', message: PIN_ANSWER },
          { type: 'turn.completed' },
        ],
      };
    case 'kimi':
      return {
        lines: [
          { role: 'assistant', content: PIN_ANSWER },
          {
            role: 'meta',
            type: 'session.resume_hint',
            session_id: PIN_KIMI_SESSION,
            command: `kimi -r ${PIN_KIMI_SESSION}`,
          },
        ],
      };
    case 'grok':
      return {
        lines: [
          { type: 'text', data: PIN_ANSWER },
          { type: 'end', stopReason: 'end_turn', sessionId: PIN_SESSION },
        ],
      };
    case 'cursor':
      return {
        lines: [
          {
            type: 'system',
            subtype: 'init',
            cwd: '/tmp',
            session_id: PIN_CURSOR_SESSION,
            model: 'Composer 2.5',
          },
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: PIN_ANSWER }] },
          },
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: 'ignored-concat',
            session_id: PIN_CURSOR_SESSION,
          },
        ],
      };
    case 'antigravity':
      return {
        lines: [
          {
            event: 'init',
            conversation_id: PIN_SESSION,
            init: {
              model: 'claude-sonnet-4-6',
              cwd: '/tmp',
              tools: [],
              permission_mode: 'always-proceed',
            },
          },
          {
            event: 'step_update',
            step_update: {
              conversation_id: PIN_SESSION,
              step_index: 0,
              state: 'DONE',
              step_type: 'user_input',
            },
          },
          {
            event: 'step_update',
            step_update: {
              conversation_id: PIN_SESSION,
              step_index: 1,
              state: 'DONE',
              step_type: 'agent_response',
              text_delta: PIN_ANSWER,
            },
          },
          {
            event: 'result',
            result: {
              conversation_id: PIN_SESSION,
              status: 'SUCCESS',
              response: PIN_ANSWER,
            },
          },
        ],
      };
    case 'devin':
      // The controlled executable encodes this answer and handle as ACP.
      return {
        lines: [PIN_ANSWER],
        exportSessionId: PIN_SESSION,
      };
    default: {
      const _never: never = kind;
      throw new Error(`unhandled agent kind: ${String(_never)}`);
    }
  }
}

export function cursorVersionedHelpText(): string {
  return CURSOR_HELP;
}

export async function installKindCli(
  root: string,
  kind: PinAgentKind,
  options: { binaryName?: string; version?: string } = {},
): Promise<KindCliInstall> {
  const binaryName = options.binaryName ?? defaultBinaryName(kind);
  const version =
    options.version ??
    (kind === 'cursor' ? 'cursor-agent 0.0.0-pin' : `${binaryName} 0.0.0-pin`);
  const success = jsonlScript(kind, 'success');
  const fake = await writeScriptedJsonlExecutable(root, binaryName, {
    version,
    helpText: kind === 'cursor' ? CURSOR_HELP : `Usage: ${binaryName}`,
    lines: success.lines,
    ...(success.exportSessionId ? { exportSessionId: success.exportSessionId } : {}),
  });
  return { kind, fake, binaryName };
}

export function withPathPrefix(dir: string, run: () => Promise<void> | void): Promise<void> {
  const previous = process.env.PATH;
  process.env.PATH = previous ? `${dir}${delimiter}${previous}` : dir;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    });
}

export function withIsolatedPath(dir: string, run: () => Promise<void> | void): Promise<void> {
  const previous = process.env.PATH;
  process.env.PATH = isolatedPathValue(dir);
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    });
}

function isolatedPathValue(dir: string): string {
  if (process.platform !== 'win32') return dir;
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return [dir, join(systemRoot, 'System32'), systemRoot].join(delimiter);
}

export function withEnvBin(
  kind: PinAgentKind,
  value: string | undefined,
  run: () => Promise<void> | void,
): Promise<void> {
  const name = envBinVarName(kind);
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
}

export function stabilizePinSnapshot(value: unknown, replacements: ReadonlyArray<readonly [string, string]> = []): unknown {
  let text = JSON.stringify(value);
  for (const [from, to] of replacements) {
    text = text.split(from).join(to);
    text = text.split(JSON.stringify(from).slice(1, -1)).join(to);
  }
  text = text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
    '<uuid>',
  );
  text = text.replace(/[0-9a-f]{8}-[0-9a-f]{3}\b/gi, '<nonce>');
  return JSON.parse(text) as unknown;
}
