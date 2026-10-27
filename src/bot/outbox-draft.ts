import type { LarkChannel } from '@larksuite/channel';
import { classify } from './feishu-error';
import { readBackDraftCard, withDraftCardReadbackMarker, withDeliveryUuid } from './feishu-delivery';
import { readCardApiError } from '../card/card-api-error';
import { draftCardBodyFromCard, type DraftCardBody } from '../automations/card-body';
import type { ManagedCardSendResult } from '../card/managed';
import type { TurnJournal } from './turn-journal';
import type { DraftCardItem } from './outbox-draft-item';
import { log } from '../core/logger';

export interface DraftCardReceipts {
  getDraftCardReceipt(draftId: string): { draftId: string; operationId?: string; deliveryId?: string; cardMessageId?: string; cardId?: string } | undefined;
  setDraftDeliveryId(draftId: string, deliveryId: string): Promise<void>;
  bindDraftCard(draftId: string, messageId: string, cardId?: string, body?: DraftCardBody): Promise<boolean>;
}

export interface DraftCardInput {
  draftId: string;
  deliveryId: string;
  chatId: string;
  createdAt: number;
  card: object;
  options: { replyTo?: string; replyInThread?: boolean; threadId?: string };
}

// Initial delivery and Recovery may overlap, including across Outbox facades.
// This only coalesces work; the persisted cardId provides crash safety.
const active = new WeakMap<TurnJournal, Map<string, Promise<ManagedCardSendResult | undefined>>>();

export function deliverDraftCard(input: {
  channel: LarkChannel;
  journal: TurnJournal;
  botAppId: string;
  draftCards: DraftCardReceipts;
  isDown?: () => boolean;
}, deliveryId: string): Promise<ManagedCardSendResult | undefined> {
  let pending = active.get(input.journal);
  if (!pending) { pending = new Map(); active.set(input.journal, pending); }
  const existing = pending.get(deliveryId);
  if (existing) return existing;
  const work = deliverOwned(input, deliveryId).finally(() => { pending!.delete(deliveryId); });
  pending.set(deliveryId, work);
  return work;
}

async function deliverOwned(input: Parameters<typeof deliverDraftCard>[0], deliveryId: string): Promise<ManagedCardSendResult | undefined> {
  const { journal, channel, draftCards } = input;
  await journal.flush();
  let item = journal.getDraftCard(deliveryId);
  if (!item || item.state === 'voided') return;
  if (item.state === 'rejected') throw Object.assign(new Error(item.rejection?.message ?? 'draft card rejected'), { code: item.rejection?.code });
  const draft = draftCards.getDraftCardReceipt(item.payload.draftId);
  if (!draft) { journal.updateDraftCard(deliveryId, { state: 'voided' }); await journal.flush(); return; }
  // Recovery can observe staging before its cross-file association committed.
  // Establish that durable association before any external send or binding.
  if (draft.deliveryId !== deliveryId) await draftCards.setDraftDeliveryId(item.payload.draftId, deliveryId);
  if (draft.cardMessageId) {
    await recordReceipt(draft.cardMessageId, draft.cardId);
    return result(journal.getDraftCard(deliveryId)!);
  }
  if (item.receipt) {
    await bind(item);
    return result(item);
  }
  if (input.isDown?.()) return;
  if (item.cardId) {
    const found = await readBackDraftCard(channel, item, input.botAppId);
    if (found) { await recordReceipt(found, item.cardId); return result(journal.getDraftCard(deliveryId)!); }
    return;
  }
  try {
    const { cardId } = await channel.createCard(item.payload.card);
    if (!cardId?.trim()) throw new Error('draft card missing card entity receipt');
    journal.updateDraftCard(deliveryId, { cardId });
    // Commit the entity before attempting a send. Restart must only read back.
    await journal.flush();
    item = journal.getDraftCard(deliveryId)!;
    if (item.state !== 'staged' || input.isDown?.() || !draftCards.getDraftCardReceipt(item.payload.draftId)) return;
    const { threadId: _thread, chatId, ...options } = item.target;
    const sent = await channel.send(chatId, { cardId }, withDeliveryUuid(options, deliveryId));
    if (!sent.messageId?.trim()) throw new Error('draft card missing message receipt');
    await recordReceipt(sent.messageId, cardId);
    return result(journal.getDraftCard(deliveryId)!);
  } catch (error) {
    const kind = classify(error);
    const api = readCardApiError(error);
    if (!item.cardId) log.fail('card', error, { step: 'managed-create', ...api });
    if ((!item.cardId && (draft.operationId || kind !== 'link')) || (item.cardId && !isCardEntityAlreadyBound(error) && kind === 'rejected')) {
      journal.updateDraftCard(deliveryId, { state: 'rejected', rejection: { message: error instanceof Error ? error.message : String(error), ...(api.code !== undefined ? { code: api.code } : {}) } });
      await journal.flush();
    }
    throw error;
  }

  async function recordReceipt(messageId: string, cardId?: string): Promise<void> {
    journal.updateDraftCard(deliveryId, { receipt: { messageId, ...(cardId ? { cardId } : {}) } });
    await journal.flush();
    await bind(journal.getDraftCard(deliveryId)!);
  }
  async function bind(current: DraftCardItem): Promise<void> {
    const latest = journal.getDraftCard(deliveryId);
    if (!latest || latest.state === 'voided' || latest.state === 'rejected') return;
    if (draftCards.getDraftCardReceipt(current.payload.draftId)?.deliveryId !== deliveryId) return;
    const receipt = current.receipt!;
    const bound = await draftCards.bindDraftCard(current.payload.draftId, receipt.messageId, receipt.cardId, draftCardBodyFromCard(current.payload.card));
    if (!bound) throw new Error('Draft Outbox receipt could not bind');
    journal.updateDraftCard(deliveryId, { state: 'sent' });
    await journal.flush();
  }
}

export function stageDraftCard(journal: TurnJournal, input: DraftCardInput): void {
  journal.stageDraftCard({
    kind: 'draft-card', deliveryId: input.deliveryId, state: 'staged', createdAt: input.createdAt,
    target: { chatId: input.chatId, ...input.options },
    payload: { draftId: input.draftId, card: withDraftCardReadbackMarker(input.card, input.deliveryId) },
  });
}

function result(item: DraftCardItem): ManagedCardSendResult | undefined {
  return item.receipt ? { messageId: item.receipt.messageId, cardId: item.receipt.cardId, kind: 'card-id' } : undefined;
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
