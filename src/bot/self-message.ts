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
  private readonly active = new Set<string>();
  private readonly sent = new Set<string>();

  begin(scope: string): void {
    this.active.add(scope);
  }

  has(scope: string): boolean {
    return this.sent.has(scope);
  }

  consume(scope: string): boolean {
    const had = this.sent.delete(scope);
    this.active.delete(scope);
    return had;
  }

  noteInbound(chatId: string, threadId?: string): boolean {
    const topicScope = threadId ? `${chatId}:${threadId}` : undefined;
    if (topicScope !== undefined && this.active.has(topicScope)) {
      this.sent.add(topicScope);
      return true;
    }
    if (this.active.has(chatId)) {
      this.sent.add(chatId);
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

const OUTBOUND_OPS = ['send', 'stream', 'updateCard', 'updateCardById'] as const;

export async function withOutboundTimeout<T>(
  op: string,
  work: Promise<T>,
  timeoutMs = OUTBOUND_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        const onAbort = (): void => {
          ctrl.signal.removeEventListener('abort', onAbort);
          reject(new OutboundTimeoutError(op, timeoutMs));
        };
        if (ctrl.signal.aborted) {
          onAbort();
          return;
        }
        ctrl.signal.addEventListener('abort', onAbort);
      }),
    ]);
  } finally {
    clearTimeout(timer);
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
  for (const op of OUTBOUND_OPS) {
    const current = mutable[op];
    if (typeof current !== 'function') continue;
    const orig = (current as (...args: unknown[]) => Promise<unknown>).bind(channel);
    mutable[op] = (...args: unknown[]) => {
      const work = orig(...args).then((result) => {
        if (op === 'send' || op === 'stream') outbound.add(outboundMessageId(result));
        return result;
      });
      return withOutboundTimeout(op, work, timeoutMs).then(
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
