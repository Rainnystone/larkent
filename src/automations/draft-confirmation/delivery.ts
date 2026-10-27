import { cardDraft } from './state';
import type { LarkChannel } from '@larksuite/channel';
import { createHash } from 'node:crypto';
import { Outbox } from '../../bot/outbox';
import type { ManagedCardSendResult } from '../../card/managed';
import type { AutomationDraft, AutomationsStore } from '../store';

export async function sendAutomationDraftCard(channel: LarkChannel, store: AutomationsStore, draft: AutomationDraft, card: object,
  options: { replyTo?: string; replyInThread?: boolean; threadId?: string }): Promise<ManagedCardSendResult> {
  const phase = draft.op !== 'delete' && draft.pendingRecurring ? 'end' : 'confirm';
  const deliveryId = createHash('sha256').update(`${draft.operationId ?? draft.draftId}:${phase}`).digest('hex').slice(0, 32);
  const outbox = store.draftOutbox ?? new Outbox({ channel, journal: store.outboxJournal, botAppId: '', draftCards: store, liveSweep: false });
  const input = { draftId: draft.draftId, chatId: draft.chatId, deliveryId, createdAt: draft.createdAt, card,
    options: { ...options, ...(draft.cardReply?.threadId ? { threadId: draft.cardReply.threadId } : {}) } };
  await outbox.stageDraftCard(input);
  await store.setDraftDeliveryId(draft.draftId, deliveryId);
  return outbox.deliverDraftCard(input);
}

export async function reconcileDraftCard(channel: LarkChannel, store: AutomationsStore, draft: AutomationDraft, botAppId?: string): Promise<void> {
  const deliveryId = cardDraft(draft).deliveryId;
  if (!deliveryId) return;
  await (store.draftOutbox ?? new Outbox({ channel, journal: store.outboxJournal, botAppId: botAppId ?? '', draftCards: store, liveSweep: false })).reconcileDraftCard(deliveryId);
}
