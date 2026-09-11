/**
 * In-run detection of a successful `lark-cli im` send to a chat.
 *
 * Rejected: post-run history check by bot identity (spec ticket quiz option c).
 * Scanning Feishu history after the run and skipping when this bot already
 * posted is racy (late WS vs our own send), identity-coupled, and cannot stay
 * runtime-equal across agent kinds. The shared reducer watches `tool_use` /
 * `tool_result` instead. `directImSentChatIds` lives only on the in-memory
 * `RunState` and is never persisted.
 */

export type DirectImSendTarget =
  | { kind: 'chat'; chatId: string }
  | { kind: 'message'; messageId: string };

export interface DirectImSendBookkeep {
  directImSentChatIds: ReadonlySet<string>;
  pendingDirectImSends: ReadonlyMap<string, DirectImSendTarget>;
  currentChatId?: string;
  batchMessageIds?: ReadonlySet<string>;
}

export const OUTBOUND_SKIP_CLI_SENT_METRIC = 'outbound_skip_cli_sent';

const LARK_CLI_NAME = /^(?:.*[/\\])?lark-cli(?:\.(?:cmd|exe))?$/i;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const IM_SEND_VERBS = new Set(['+messages-send', '+messages-reply', 'send-card']);
const CHAT_ID_VALUE = /^(oc_[A-Za-z0-9_-]+|ou_[A-Za-z0-9_-]+)$/;
const MESSAGE_ID_VALUE = /^(om_[A-Za-z0-9_-]+)$/;

export function parseDirectImSendTarget(input: unknown): DirectImSendTarget | undefined {
  const argv = commandArgv(input);
  if (!argv) return undefined;
  const start = argv.findIndex((token) => !ENV_ASSIGNMENT.test(token));
  if (start < 0) return undefined;
  const invoked = argv.slice(start);
  if (invoked.length < 3) return undefined;
  if (!LARK_CLI_NAME.test(invoked[0] ?? '') || invoked[1] !== 'im') return undefined;
  const verb = invoked[2];
  if (!verb || !IM_SEND_VERBS.has(verb)) return undefined;
  return flagsTarget(invoked.slice(3));
}

export function isSuccessfulImResult(output: string, isError: boolean): boolean {
  if (isError) return false;
  const json = extractJson(output);
  if (json === undefined) return false;
  if (jsonIndicatesError(json)) return false;
  return jsonHasMessageReceipt(json);
}

export function rememberDirectImSend(
  state: DirectImSendBookkeep,
  toolId: string,
  input: unknown,
): ReadonlyMap<string, DirectImSendTarget> {
  const target = parseDirectImSendTarget(input);
  if (!target) return state.pendingDirectImSends;
  const next = new Map(state.pendingDirectImSends);
  next.set(toolId, target);
  return next;
}

export function confirmDirectImSend(
  state: DirectImSendBookkeep,
  toolId: string,
  output: string,
  isError: boolean,
): Pick<DirectImSendBookkeep, 'directImSentChatIds' | 'pendingDirectImSends'> {
  const pending = new Map(state.pendingDirectImSends);
  const target = pending.get(toolId);
  pending.delete(toolId);
  if (!target || !isSuccessfulImResult(output, isError)) {
    return { pendingDirectImSends: pending, directImSentChatIds: state.directImSentChatIds };
  }
  const chatId = resolveDirectImChatId(target, state);
  if (!chatId) {
    return { pendingDirectImSends: pending, directImSentChatIds: state.directImSentChatIds };
  }
  const chats = new Set(state.directImSentChatIds);
  chats.add(chatId);
  return { pendingDirectImSends: pending, directImSentChatIds: chats };
}

export function resolveDirectImChatId(
  target: DirectImSendTarget,
  ctx: Pick<DirectImSendBookkeep, 'currentChatId' | 'batchMessageIds'>,
): string | undefined {
  switch (target.kind) {
    case 'chat':
      return target.chatId;
    case 'message':
      return ctx.currentChatId && ctx.batchMessageIds?.has(target.messageId)
        ? ctx.currentChatId
        : undefined;
    default: {
      const _never: never = target;
      return _never;
    }
  }
}

function commandArgv(input: unknown): string[] | undefined {
  if (typeof input === 'string') return tokenize(input);
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  if (Array.isArray(rec.command) && rec.command.every((part) => typeof part === 'string')) {
    return rec.command;
  }
  if (typeof rec.command === 'string') return tokenize(rec.command);
  if (typeof rec.cmd === 'string') return tokenize(rec.cmd);
  return undefined;
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const token = /(?:'([^']*)'|"([^"]*)"|(\S+))/g;
  for (const match of command.matchAll(token)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

function flagsTarget(flags: string[]): DirectImSendTarget | undefined {
  let chatId: string | undefined;
  let messageId: string | undefined;
  for (let i = 0; i < flags.length; i++) {
    const token = flags[i];
    if (token === undefined) continue;
    const next = flags[i + 1];
    if (token === '--chat-id' && next) {
      chatId = unquote(next);
      i += 1;
      continue;
    }
    if (token.startsWith('--chat-id=')) {
      chatId = unquote(token.slice('--chat-id='.length));
      continue;
    }
    if (token === '--message-id' && next) {
      messageId = unquote(next);
      i += 1;
      continue;
    }
    if (token.startsWith('--message-id=')) {
      messageId = unquote(token.slice('--message-id='.length));
    }
  }
  if (chatId && CHAT_ID_VALUE.test(chatId)) return { kind: 'chat', chatId };
  if (messageId && MESSAGE_ID_VALUE.test(messageId)) return { kind: 'message', messageId };
  return undefined;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function jsonHasMessageReceipt(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.message_id === 'string' && rec.message_id.length > 0) return true;
  if (rec.code === 0 || rec.code === '0') return true;
  return rec.data !== undefined && jsonHasMessageReceipt(rec.data);
}

function extractJson(output: string): unknown | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return undefined;
    }
  }
}

function jsonIndicatesError(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (rec.ok === false) return true;
  if (typeof rec.error === 'string' && rec.error.length > 0) return true;
  if (rec.error && typeof rec.error === 'object') return true;
  return hasNonZeroCode(rec.code) || hasNonZeroCode(rec.error_code);
}

function hasNonZeroCode(code: unknown): boolean {
  if (typeof code === 'number') return code !== 0;
  if (typeof code === 'string') return code !== '0' && code !== 'ok' && code !== 'success';
  return false;
}
