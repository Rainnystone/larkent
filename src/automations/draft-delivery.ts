import type { LarkChannel } from '@larksuite/channel';
import { createHash } from 'node:crypto';
import { classify } from '../bot/feishu-error';
import { FEISHU_READBACK_MAX_PAGES, feishuReadbackListParams } from '../bot/feishu-delivery';
import { readCardApiError } from '../card/card-api-error';
import { sendManagedCard, type ManagedCardSendResult } from '../card/managed';
import { draftCardBodyFromCard } from './card-body';
import type { AutomationDraft, AutomationsStore } from './store';

/** Same draft/card path; machine writes additionally persist the send intent and receipt. */
export async function sendAutomationDraftCard(channel: LarkChannel, store: AutomationsStore, draft: AutomationDraft, card: object,
  options: { replyTo?: string; replyInThread?: boolean }): Promise<ManagedCardSendResult> {
  if (!draft.operationId) return sendManagedCard(channel, draft.chatId, card, options);
  const deliveryId = createHash('sha256').update(`${draft.operationId}:${draft.op !== 'delete' && draft.pendingRecurring ? 'end' : 'confirm'}`).digest('hex').slice(0, 32);
  const marked = withDraftCardReadbackMarker(card, deliveryId);
  await store.setDraftDelivery(draft.draftId, { state: 'prepared', deliveryId, card: marked });
  let cardId: string;
  try { ({ cardId } = await channel.createCard(marked)); }
  catch (error) { await store.setDraftDelivery(draft.draftId, { state: 'rejected', deliveryId, card: marked }); throw error; }
  // This must commit before the send. A crash/timeout from here is UNKNOWN, never a new send.
  await store.setDraftDelivery(draft.draftId, { state: 'sending', deliveryId, card: marked, cardId });
  try {
    const sent = await channel.send(draft.chatId, { cardId }, { ...options, uuid: deliveryId });
    if (!sent.messageId?.trim()) throw new Error('draft card missing message receipt');
    return { messageId: sent.messageId, cardId, kind: 'card-id' };
  } catch (error) {
    if (!isCardEntityAlreadyBound(error) && classify(error) === 'rejected') {
      await store.setDraftDelivery(draft.draftId, { state: 'rejected', deliveryId, card: marked, cardId });
    }
    throw error;
  }
}

/** Positive evidence is this draft's button element_id in a user_card_content readback. Absence proves nothing. */
export async function reconcileDraftCard(channel: LarkChannel, store: AutomationsStore, draft: AutomationDraft, botAppId?: string): Promise<void> {
  const delivery = draft.delivery;
  if (!delivery || delivery.state !== 'sending' || !botAppId) return;
  const marker = draftCardReadbackElementId(delivery.deliveryId);
  if (!collectElementIds(delivery.card).includes(marker)) return;
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
      if (item.sender?.id !== botAppId || item.sender?.sender_type !== 'app' || item.msg_type !== 'interactive' || !item.message_id || !Number.isFinite(Number(item.create_time)) || Number(item.create_time) < draft.createdAt) continue;
      let body: unknown;
      try { body = JSON.parse(item.body?.content ?? ''); } catch { continue; }
      if (collectElementIds(body).includes(marker)) matches.add(item.message_id);
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

function draftCardReadbackElementId(deliveryId: string): string {
  return `lbd${deliveryId.slice(0, 17)}`;
}

function withDraftCardReadbackMarker(card: object, deliveryId: string): object {
  const marked = structuredClone(card);
  const target = findButton(marked, (button) => buttonLabel(button) === '是')
    ?? findButton(marked, (button) => button.type === 'primary');
  if (target) target.element_id = draftCardReadbackElementId(deliveryId);
  return marked;
}

function collectElementIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectElementIds);
  if (!value || typeof value !== 'object') return [];
  const rec = value as Record<string, unknown>;
  const own = typeof rec.element_id === 'string' && rec.element_id ? [rec.element_id] : [];
  return own.concat(Object.values(rec).flatMap(collectElementIds));
}

function findButton(value: unknown, match: (button: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findButton(entry, match);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  if (rec.tag === 'button' && match(rec)) return rec;
  for (const child of Object.values(rec)) {
    const found = findButton(child, match);
    if (found) return found;
  }
  return undefined;
}

function buttonLabel(button: Record<string, unknown>): string {
  const text = button.text && typeof button.text === 'object' ? button.text as Record<string, unknown> : undefined;
  return typeof text?.content === 'string' ? text.content : '';
}

/** Card-entity send: the card_id is already bound, so uuid retry cannot recover the receipt. */
function isCardEntityAlreadyBound(error: unknown): boolean {
  const api = readCardApiError(error);
  if (api.code !== 230099) return false;
  return `${api.msg ?? ''} ${errorText(error)}`.includes('200780');
}

function errorText(error: unknown): string {
  const chunks: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const rec = current as { message?: unknown; msg?: unknown; ext?: unknown; cause?: unknown; response?: { data?: { msg?: unknown; ext?: unknown } } };
    if (typeof rec.message === 'string') chunks.push(rec.message);
    if (typeof rec.msg === 'string') chunks.push(rec.msg);
    if (typeof rec.ext === 'string') chunks.push(rec.ext);
    const data = rec.response?.data;
    if (typeof data?.msg === 'string') chunks.push(data.msg);
    if (typeof data?.ext === 'string') chunks.push(data.ext);
    current = rec.cause;
  }
  return chunks.join(' ');
}
