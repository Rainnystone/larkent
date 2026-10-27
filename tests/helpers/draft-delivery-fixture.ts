import { draftConfirmationDelivery } from '../../src/automations/draft-confirmation';
import type { AutomationsStore, DraftDelivery } from '../../src/automations/store';

/** Seed durable delivery evidence through the journal for recovery scenarios. */
export async function seedDraftDelivery(store: AutomationsStore, draftId: string, delivery: DraftDelivery): Promise<void> {
  const draft = store.getDraft(draftId)!;
  store.outboxJournal.stageDraftCard({
    kind: 'draft-card', deliveryId: delivery.deliveryId,
    state: delivery.state === 'prepared' || delivery.state === 'sending' ? 'staged' : delivery.state,
    createdAt: draft.createdAt, target: { chatId: draft.chatId, ...draft.cardReply },
    payload: { draftId, card: delivery.card }, ...(delivery.cardId ? { cardId: delivery.cardId } : {}),
    ...(delivery.state === 'sent' ? { receipt: { messageId: draftConfirmationDelivery(draft).messageId!, cardId: delivery.cardId } } : {}),
  });
  await store.outboxJournal.flush();
  await store.setDraftDeliveryId(draftId, delivery.deliveryId);
}
