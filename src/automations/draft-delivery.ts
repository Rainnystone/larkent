import type { LarkChannel } from '@larksuite/channel';
import { createHash } from 'node:crypto';
import { classify } from '../bot/feishu-error';
import { FEISHU_READBACK_MAX_PAGES, feishuReadbackListParams } from '../bot/feishu-delivery';
import { sendManagedCard, type ManagedCardSendResult } from '../card/managed';
import { draftCardBodyFromCard } from './card-body';
import type { AutomationDraft, AutomationsStore } from './store';

/** Same draft/card path; machine writes additionally persist the send intent and receipt. */
export async function sendAutomationDraftCard(channel: LarkChannel, store: AutomationsStore, draft: AutomationDraft, card: object,
  options: { replyTo?: string; replyInThread?: boolean }): Promise<ManagedCardSendResult> {
  if (!draft.operationId) return sendManagedCard(channel, draft.chatId, card, options);
  const deliveryId = createHash('sha256').update(`${draft.operationId}:${draft.op !== 'delete' && draft.pendingRecurring ? 'end' : 'confirm'}`).digest('hex').slice(0, 32);
  await store.setDraftDelivery(draft.draftId, { state: 'prepared', deliveryId, card });
  let cardId: string;
  try { ({ cardId } = await channel.createCard(card)); }
  catch (error) { await store.setDraftDelivery(draft.draftId, { state: 'rejected', deliveryId, card }); throw error; }
  // This must commit before the send. A crash/timeout from here is UNKNOWN, never a new send.
  await store.setDraftDelivery(draft.draftId, { state: 'sending', deliveryId, card, cardId });
  try {
    const sent = await channel.send(draft.chatId, { cardId }, { ...options, uuid: deliveryId });
    if (!sent.messageId?.trim()) throw new Error('draft card missing message receipt');
    return { messageId: sent.messageId, cardId, kind: 'card-id' };
  } catch (error) {
    if (classify(error) === 'rejected') await store.setDraftDelivery(draft.draftId, { state: 'rejected', deliveryId, card, cardId });
    throw error;
  }
}

/** Only an exact signed callback from this bot is positive evidence. Absence proves nothing. */
export async function reconcileDraftCard(channel: LarkChannel, store: AutomationsStore, draft: AutomationDraft, botAppId?: string): Promise<void> {
  const delivery = draft.delivery;
  if (!delivery || delivery.state !== 'sending' || !botAppId) return;
  const tokens = callbackTokens(delivery.card);
  let pageToken: string | undefined;
  const matches = new Set<string>();
  const inThread = draft.cardReply?.replyInThread === true;
  const container = inThread ? draft.cardReply?.threadId : draft.chatId;
  if (!container) return;
  for (let page = 0; page < FEISHU_READBACK_MAX_PAGES; page++) {
    const response = await channel.rawClient.im.v1.message.list({ params: feishuReadbackListParams({
      containerId: container, inThread, afterMs: draft.createdAt, pageToken,
    }) });
    const data = response?.data;

    for (const item of data?.items ?? []) {
      if (item.sender?.id !== botAppId || item.sender?.sender_type !== 'app' || !item.message_id || !Number.isFinite(Number(item.create_time)) || Number(item.create_time) < draft.createdAt) continue;
      let body: unknown;
      try { body = JSON.parse(item.body?.content ?? ''); } catch { continue; }
      const found = callbackTokens(body);
      if (tokens.some(token => found.includes(token))) matches.add(item.message_id);
    }
    if (matches.size > 1) return;
    if (!data?.has_more) {
      if (matches.size === 1) await store.bindDraftCard(draft.draftId, [...matches][0]!, delivery.cardId, draftCardBodyFromCard(delivery.card));
      return;
    }
    if (!data.page_token) return;
    pageToken = data.page_token;
  }
}
function callbackTokens(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => key === 'auto_token' && typeof child === 'string' ? [child] : callbackTokens(child));
}
