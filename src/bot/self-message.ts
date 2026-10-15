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
  private readonly chatIds = new Set<string>();

  note(chatId: string): void {
    this.chatIds.add(chatId);
  }

  has(chatId: string): boolean {
    return this.chatIds.has(chatId);
  }

  sentChatIds(): ReadonlySet<string> {
    return this.chatIds;
  }
}

export function noteInboundSkipSelf(input: {
  messageId: string;
  chatId: string;
  isSelf: boolean;
  outbound: Pick<OutboundMessageIds, 'has'>;
  runActive: boolean;
  tracker: CliSelfSendTracker;
}): boolean {
  if (!input.isSelf) return false;
  if (input.runActive && !input.outbound.has(input.messageId)) {
    input.tracker.note(input.chatId);
  }
  return true;
}

export function wrapChannelOutbound(
  channel: {
    send: (...args: Parameters<LarkChannelSend>) => ReturnType<LarkChannelSend>;
    stream: (...args: Parameters<LarkChannelStream>) => ReturnType<LarkChannelStream>;
  },
  outbound: OutboundMessageIds,
): void {
  const origSend = channel.send.bind(channel);
  const origStream = channel.stream.bind(channel);
  channel.send = ((...args: Parameters<LarkChannelSend>) =>
    origSend(...args).then((result: unknown) => {
      outbound.add(outboundMessageId(result));
      return result;
    })) as typeof channel.send;
  channel.stream = ((...args: Parameters<LarkChannelStream>) =>
    origStream(...args).then((result: unknown) => {
      outbound.add(outboundMessageId(result));
      return result;
    })) as typeof channel.stream;
}

type LarkChannelSend = (chatId: string, content: unknown, options?: unknown) => Promise<unknown>;
type LarkChannelStream = (chatId: string, input: unknown, options?: unknown) => Promise<unknown>;
