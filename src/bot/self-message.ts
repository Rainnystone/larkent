/**
 * Shared skip-self predicate used by backfill and by the live inbound path.
 *
 * A message is "already sent by us" for final-reply purposes when it is
 * skip-self (own app / bot open id / p2p app sender) AND its id is not in
 * the bridge outbound record. That conjunction is the CLI self-send case:
 * lark-cli posted, the echo arrived here, and the bridge did not send it.
 */

export interface SelfSenderInput {
  senderId?: string;
  senderType?: string;
  chatType: string;
  botOpenId?: string;
  botAppId?: string;
}

export function isSelfSender(input: SelfSenderInput): boolean {
  const senderId = input.senderId;
  if (senderId !== undefined && senderId === input.botOpenId) return true;
  if (senderId !== undefined && input.botAppId !== undefined && senderId === input.botAppId) {
    return true;
  }
  return input.chatType === 'p2p' && input.senderType === 'app';
}

export function senderTypeFromRaw(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const sender = (raw as { sender?: { sender_type?: unknown } }).sender;
  return typeof sender?.sender_type === 'string' ? sender.sender_type : undefined;
}

export class OutboundMessageIds {
  private readonly ids = new Set<string>();

  add(id: string | undefined): void {
    if (id) this.ids.add(id);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }
}

export function outboundMessageId(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const rec = result as Record<string, unknown>;
  if (typeof rec.messageId === 'string' && rec.messageId.length > 0) return rec.messageId;
  if (typeof rec.message_id === 'string' && rec.message_id.length > 0) return rec.message_id;
  return undefined;
}

export class CliSelfSendTracker {
  private readonly active = new Map<string, string | undefined>();
  private readonly sent = new Map<string, string | undefined>();

  begin(scope: string, turnId?: string): void {
    this.active.set(scope, turnId);
  }

  has(scope: string): boolean {
    return this.sent.has(scope);
  }

  turnIdFor(scope: string): string | undefined {
    return this.sent.get(scope) ?? this.active.get(scope);
  }

  consume(scope: string): boolean {
    const had = this.sent.delete(scope);
    this.active.delete(scope);
    return had;
  }

  noteInbound(chatId: string, threadId?: string): boolean {
    const topicScope = threadId ? `${chatId}:${threadId}` : undefined;
    if (topicScope !== undefined && this.active.has(topicScope)) {
      this.sent.set(topicScope, this.active.get(topicScope));
      return true;
    }
    if (this.active.has(chatId)) {
      this.sent.set(chatId, this.active.get(chatId));
      return true;
    }
    return false;
  }
}

export function noteInboundSkipSelf(input: {
  messageId: string;
  chatId: string;
  threadId?: string;
  isSelf: boolean;
  outbound: Pick<OutboundMessageIds, 'has'>;
  tracker: CliSelfSendTracker;
}): boolean {
  if (!input.isSelf) return false;
  if (!input.outbound.has(input.messageId)) {
    input.tracker.noteInbound(input.chatId, input.threadId);
  }
  return true;
}

export const OUTBOUND_REQUEST_TIMEOUT_MS = 30_000;

export class OutboundTimeoutError extends Error {
  constructor(readonly op: string, readonly timeoutMs: number) {
    super(`outbound ${op} timed out after ${timeoutMs}ms`);
    this.name = 'OutboundTimeoutError';
  }
}

const TIMED_CHANNEL_OPS = [
  'send',
  'updateCard',
  'updateCardById',
  'getChatMode',
  'getAppInfo',
  'listChats',
  'fetchRawMessage',
  'fetchMessage',
] as const;
const WRAPPED_CHANNEL_OPS = [...TIMED_CHANNEL_OPS, 'stream'] as const;

export async function withOutboundTimeout<T>(
  op: string,
  work: Promise<T>,
  timeoutMs = OUTBOUND_REQUEST_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new OutboundTimeoutError(op, timeoutMs));
    }, timeoutMs);
  });
  const settled = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    const winner = await Promise.race([
      settled,
      timeout.then(
        () => ({ ok: 'timeout' as const, error: new OutboundTimeoutError(op, timeoutMs) }),
        (error: unknown) => ({ ok: 'timeout' as const, error }),
      ),
    ]);
    if (winner.ok === true) return winner.value;
    throw winner.error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function wrapChannelOutbound(
  channel: object,
  outbound: OutboundMessageIds,
  opts: {
    timeoutMs?: number;
    onResult?: (result: { ok: true } | { ok: false; error: unknown }) => void;
  } = {},
): void {
  const timeoutMs = opts.timeoutMs ?? OUTBOUND_REQUEST_TIMEOUT_MS;
  const mutable = channel as Record<string, unknown>;
  for (const op of WRAPPED_CHANNEL_OPS) {
    const current = mutable[op];
    if (typeof current !== 'function') continue;
    const orig = (current as (...args: unknown[]) => Promise<unknown>).bind(channel);
    mutable[op] = (...args: unknown[]) => {
      const callArgs = op === 'stream'
        ? [args[0], wrapStreamProducer(args[1], outbound), ...args.slice(2)]
        : args;
      const work = orig(...callArgs).then((result) => {
        if (op === 'send' || op === 'stream') outbound.add(outboundMessageId(result));
        return result;
      });
      const pending = isTimedChannelOp(op) ? withOutboundTimeout(op, work, timeoutMs) : work;
      return pending.then(
        (result) => {
          opts.onResult?.({ ok: true });
          return result;
        },
        (error: unknown) => {
          opts.onResult?.({ ok: false, error });
          throw error;
        },
      );
    };
  }
}

function isTimedChannelOp(op: (typeof WRAPPED_CHANNEL_OPS)[number]): boolean {
  return (TIMED_CHANNEL_OPS as readonly string[]).includes(op);
}

function wrapStreamProducer(input: unknown, outbound: OutboundMessageIds): unknown {
  if (!input || typeof input !== 'object') return input;
  const rec = input as Record<string, unknown>;
  if (rec.card && typeof rec.card === 'object' && rec.card !== null) {
    const card = rec.card as {
      initial?: unknown;
      producer?: (ctrl: { messageId?: string }) => Promise<void> | void;
    };
    if (typeof card.producer === 'function') {
      const producer = card.producer;
      return {
        ...rec,
        card: {
          ...card,
          producer: async (ctrl: { messageId?: string }) => {
            outbound.add(ctrl.messageId);
            return producer(ctrl);
          },
        },
      };
    }
  }
  if (typeof rec.markdown === 'function') {
    const markdown = rec.markdown as (ctrl: { messageId?: string }) => Promise<void> | void;
    return {
      ...rec,
      markdown: async (ctrl: { messageId?: string }) => {
        outbound.add(ctrl.messageId);
        return markdown(ctrl);
      },
    };
  }
  return input;
}
