import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect } from 'vitest';
import type { AgentAdapter } from '../../src/agent/types.js';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import { CursorAdapter } from '../../src/agent/cursor/adapter.js';
import { GrokAdapter } from '../../src/agent/grok/adapter.js';
import { KimiAdapter } from '../../src/agent/kimi/adapter.js';
import { normalizeCard } from './card-normalize.js';
import type { ScriptedJsonlRecord } from './fake-executable.js';

export const PINNED_AGENT_KINDS = ['claude', 'codex', 'kimi', 'grok', 'cursor'] as const;
export type PinnedAgentKind = (typeof PINNED_AGENT_KINDS)[number];

export const PIN_ANSWER = 'PIN_ANSWER';
export const PIN_PROMPT = 'PIN_PROMPT';

const CLAUDE_SESSION = 'sess-pin-p1';
const CODEX_THREAD = 'thread-pin-p1';
const KIMI_SESSION = 'session_pin_p1';
const GROK_SESSION = '11111111-2222-4333-8444-555555555555';
const CURSOR_SESSION = '66666666-7777-4888-8999-aaaaaaaaaaaa';

export type ScriptedScenario = 'happy' | 'error' | 'doctor';

export function scriptedJsonlLines(kind: PinnedAgentKind, scenario: ScriptedScenario): unknown[] {
  if (scenario === 'error') return [];
  const answer = scenario === 'doctor' ? 'OK' : PIN_ANSWER;
  switch (kind) {
    case 'claude':
      return [
        {
          type: 'system',
          subtype: 'init',
          session_id: CLAUDE_SESSION,
          cwd: '/tmp',
          model: 'pin',
        },
        { type: 'assistant', message: { content: [{ type: 'text', text: answer }] } },
        { type: 'result', session_id: CLAUDE_SESSION },
      ];
    case 'codex':
      return [
        { type: 'thread.started', thread_id: CODEX_THREAD },
        { type: 'agent_message', message: answer },
        { type: 'turn.completed' },
      ];
    case 'kimi':
      return [
        { role: 'assistant', content: answer },
        {
          role: 'meta',
          type: 'session.resume_hint',
          session_id: KIMI_SESSION,
          command: `kimi -r ${KIMI_SESSION}`,
        },
      ];
    case 'grok':
      return [
        { type: 'text', data: answer },
        { type: 'end', stopReason: 'end_turn', sessionId: GROK_SESSION },
      ];
    case 'cursor':
      return [
        {
          type: 'system',
          subtype: 'init',
          cwd: '/tmp',
          session_id: CURSOR_SESSION,
          model: 'Composer 2.5',
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: answer }] },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'ignored-concat',
          session_id: CURSOR_SESSION,
        },
      ];
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled agent kind: ${exhaustive}`);
    }
  }
}

export function scriptedBinaryName(kind: PinnedAgentKind): string {
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
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled agent kind: ${exhaustive}`);
    }
  }
}

export function scriptedVersion(kind: PinnedAgentKind): string {
  switch (kind) {
    case 'claude':
      return 'claude 1.0.0';
    case 'codex':
      return 'codex 1.0.0';
    case 'kimi':
      return 'kimi 1.0.0';
    case 'grok':
      return 'grok 1.0.0';
    case 'cursor':
      return 'cursor-agent 2026.08.28';
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled agent kind: ${exhaustive}`);
    }
  }
}

export type ScriptedCatalogHandle =
  | { field: 'sessionId'; sessionId: string }
  | { field: 'threadId'; threadId: string };

/** Resume handle emitted by `scriptedJsonlLines` and persisted on catalog upsert. */
export function scriptedCatalogHandle(kind: PinnedAgentKind): ScriptedCatalogHandle {
  switch (kind) {
    case 'claude':
      return { field: 'sessionId', sessionId: CLAUDE_SESSION };
    case 'codex':
      return { field: 'threadId', threadId: CODEX_THREAD };
    case 'kimi':
      return { field: 'sessionId', sessionId: KIMI_SESSION };
    case 'grok':
      return { field: 'sessionId', sessionId: GROK_SESSION };
    case 'cursor':
      return { field: 'sessionId', sessionId: CURSOR_SESSION };
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled agent kind: ${exhaustive}`);
    }
  }
}

export function createPinnedAdapter(
  kind: PinnedAgentKind,
  binary: string,
  profileDir: string,
): AgentAdapter {
  switch (kind) {
    case 'claude':
      return new ClaudeAdapter({ binary });
    case 'codex':
      return new CodexAdapter({
        binary,
        profileStateDir: profileDir,
        sandbox: 'danger-full-access',
      });
    case 'kimi':
      return new KimiAdapter({ binary });
    case 'grok':
      return new GrokAdapter({ binary });
    case 'cursor':
      return new CursorAdapter({ binary });
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled agent kind: ${exhaustive}`);
    }
  }
}

export async function readScriptedRecords(recordPath: string): Promise<ScriptedJsonlRecord[]> {
  try {
    const text = await readFile(recordPath, 'utf8');
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ScriptedJsonlRecord);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export function assertGoldenFile(file: string, actual: unknown): void {
  if (process.env.UPDATE_PIN_GOLDENS === '1') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  const expected = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  expect(actual).toEqual(expected);
}

export function sanitizePinValue(value: unknown, replacements: ReadonlyArray<readonly [RegExp | string, string]> = []): unknown {
  const normalized = normalizeCard(value);
  let next = JSON.stringify(normalized);
  const expanded: Array<readonly [RegExp | string, string]> = [];
  for (const [from, to] of replacements) {
    if (typeof from === 'string') {
      const escaped = JSON.stringify(from).slice(1, -1);
      if (escaped !== from) expanded.push([escaped, to]);
    }
    expanded.push([from, to]);
  }
  for (const [from, to] of expanded) {
    next = typeof from === 'string' ? next.split(from).join(to) : next.replace(from, to);
  }
  next = next
    .replace(/<(tmp-root|workspace|tmp)>(?:\\\\)+/g, '<$1>/')
    .replace(/\/resume use [a-f0-9-]+/gi, '/resume use <resume-nonce>')
    .replace(/"arg":"[a-f0-9-]{8,36}"/g, '"arg":"<resume-nonce>"')
    .replace(/`[a-f0-9]{8}…`/g, '`<resume-nonce>…`')
    .replace(/\/(?:tmp|var\/folders)\/[^\s"'`\\]+/g, '<tmp>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
  return JSON.parse(next) as unknown;
}

export interface RecordedChannelCall {
  op: 'send' | 'stream' | 'create-card' | 'reaction-add' | 'reaction-remove';
  chatId?: string;
  mode?: 'card' | 'markdown';
  content?: unknown;
  updates?: unknown[];
  options?: unknown;
  emojiType?: string;
}

export interface RecordingLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: {
    message?: (msg: unknown) => Promise<void> | void;
  };
  calls: RecordedChannelCall[];
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  on(handlers: RecordingLarkChannel['handlers']): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'p2p' | 'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  listChats(): Promise<unknown[]>;
  getAppInfo(): Promise<{ ownerId: string }>;
  recallMessage(messageId: string): Promise<void>;
  createCard(card: unknown): Promise<{ cardId: string }>;
  updateCardById(cardId: string, card: unknown, sequence: number): Promise<void>;
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<{ messageId: string }>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  rawClient: {
    request(method: string, params: unknown): Promise<unknown>;
    application: { v6: { application: { get(): Promise<unknown> } } };
    im: {
      v1: {
        message: { get(): Promise<unknown> };
        messageReaction: {
          create(): Promise<{ data: { reaction_id: string } }>;
          delete(): Promise<unknown>;
        };
      };
    };
  };
}

export function envBinVar(kind: PinnedAgentKind): string {
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
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled agent kind: ${exhaustive}`);
    }
  }
}

export function pinnedDisplayName(kind: PinnedAgentKind): string {
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
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled agent kind: ${exhaustive}`);
    }
  }
}

export async function withProcessEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const keys = Object.keys(overrides);
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fn();
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function waitForQuietCalls(
  channel: { calls: readonly unknown[] },
  timeoutMs = 8000,
  quietMs = 250,
): Promise<void> {
  await waitUntil(() => channel.calls.length > 0, timeoutMs);
  let lastCount = channel.calls.length;
  let lastChange = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (channel.calls.length !== lastCount) {
      lastCount = channel.calls.length;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for pin harness to go quiet');
}

export function createRecordingLarkChannel(identity?: {
  openId?: string;
  name?: string;
}): RecordingLarkChannel {
  const handlers: RecordingLarkChannel['handlers'] = {};
  const calls: RecordedChannelCall[] = [];
  const sent: RecordingLarkChannel['sent'] = [];
  let nextMessage = 1;
  let nextCard = 1;
  let nextReaction = 1;

  const channel: RecordingLarkChannel = {
    botIdentity: { openId: identity?.openId ?? 'ou_bot', name: identity?.name ?? 'Bridge' },
    handlers,
    calls,
    sent,
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'p2p';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async listChats() {
      return [];
    },
    async getAppInfo() {
      return { ownerId: 'ou_owner' };
    },
    async recallMessage() {},
    async createCard(card) {
      const cardId = `card_pin_${nextCard++}`;
      calls.push({ op: 'create-card', content: card });
      return { cardId };
    },
    async updateCardById() {},
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
      calls.push({ op: 'send', chatId, content, options });
      return { messageId: `om_sent_${nextMessage++}` };
    },
    async stream(chatId, input, options) {
      const record: RecordedChannelCall = { op: 'stream', chatId, options, updates: [] };
      if (isCardStreamInput(input)) {
        record.mode = 'card';
        record.content = input.card.initial;
        await input.card.producer({
          update: async (card: unknown) => {
            record.updates?.push(card);
          },
        });
      } else if (isMarkdownStreamInput(input)) {
        record.mode = 'markdown';
        await input.markdown({
          setContent: async (markdown: string) => {
            record.updates?.push(markdown);
          },
        });
      }
      calls.push(record);
      return { messageId: `om_stream_${nextMessage++}` };
    },
    async addReaction(_messageId, emojiType) {
      calls.push({ op: 'reaction-add', emojiType });
      return `reaction_${nextReaction++}`;
    },
    async removeReaction() {
      calls.push({ op: 'reaction-remove' });
    },
    rawClient: {
      async request() {
        return undefined;
      },
      application: {
        v6: {
          application: {
            async get() {
              return { data: { app: { owner: { owner_id: 'ou_owner' } } } };
            },
          },
        },
      },
      im: {
        v1: {
          message: {
            async get() {
              return { data: { items: [] } };
            },
          },
          messageReaction: {
            async create() {
              return { data: { reaction_id: `reaction_${nextReaction++}` } };
            },
            async delete() {
              return {};
            },
          },
        },
      },
    },
  };
  return channel;
}

export async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for pin harness');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCardStreamInput(value: unknown): value is {
  card: {
    initial: unknown;
    producer(ctrl: { update(card: unknown): Promise<void> }): Promise<void> | void;
  };
} {
  if (!isRecord(value) || !isRecord(value.card)) return false;
  return typeof value.card.producer === 'function';
}

function isMarkdownStreamInput(value: unknown): value is {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
} {
  return isRecord(value) && typeof value.markdown === 'function';
}
