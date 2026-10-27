import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import type { ChatMode } from '../bot/chat-mode-cache';
import type { PendingQueue } from '../bot/pending-queue';

/** A card invokes an action in the clicked chat, with the clicker as actor. */
export function cardActionMessage(
  event: CardActionEvent,
  mode: ChatMode,
  threadId?: string,
): NormalizedMessage {
  return {
    messageId: event.messageId,
    chatId: event.chatId,
    chatType: mode === 'p2p' ? 'p2p' : 'group',
    threadId,
    senderId: event.operator.openId,
    senderName: event.operator.name,
    content: '',
    rawContentType: 'interactive',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}

/** Both bridge callbacks and continuation clicks enter the same pending queue. */
export function enqueueActionMessage(
  pending: Pick<PendingQueue, 'push'> | undefined,
  scope: string,
  message: NormalizedMessage,
  followUp: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'content' | 'rawContentType'>,
): void {
  pending?.push(scope, { ...message, ...followUp, createTime: Date.now() });
}
