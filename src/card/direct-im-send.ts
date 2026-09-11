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

const LARK_CLI_IM = /\blark-cli\s+im\b/i;
const IM_SEND_VERB = /(?:\+messages-send|\+messages-reply|\bsend-card\b)/i;
const CHAT_ID = /--chat-id(?:\s+|=)["']?(oc_[A-Za-z0-9_-]+|ou_[A-Za-z0-9_-]+)/i;
const MESSAGE_ID = /--message-id(?:\s+|=)["']?(om_[A-Za-z0-9_-]+)/i;

export function parseDirectImSendTarget(input: unknown): DirectImSendTarget | undefined {
  const command = commandText(input);
  if (!command || !LARK_CLI_IM.test(command) || !IM_SEND_VERB.test(command)) return undefined;
  const chat = command.match(CHAT_ID);
  if (chat?.[1]) return { kind: 'chat', chatId: chat[1] };
  const message = command.match(MESSAGE_ID);
  if (message?.[1]) return { kind: 'message', messageId: message[1] };
  return undefined;
}

export function isSuccessfulImResult(output: string, isError: boolean): boolean {
  if (isError) return false;
  const json = extractJson(output);
  if (json === undefined) return true;
  return !jsonIndicatesError(json);
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

function commandText(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  if (typeof rec.command === 'string') return rec.command;
  if (Array.isArray(rec.command) && rec.command.every((part) => typeof part === 'string')) {
    return rec.command.join(' ');
  }
  if (typeof rec.cmd === 'string') return rec.cmd;
  return undefined;
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
