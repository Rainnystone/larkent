import type { DraftCardItem } from '../../bot/outbox-draft-item';
import type { AutomationDraft, DraftDelivery, DraftCardReply, UpdateDraftPatch } from '../store';
import type { TurnJournal } from '../../bot/turn-journal';
import type { DraftCardBody } from '../card-body';
import { cloneDraftCardBody, parseDraftCardBody } from '../card-body';

/** Internal persisted representation. Callers only receive AutomationDraft. */
export type CardDraft = AutomationDraft & {
  delivery?: DraftDelivery;
  deliveryId?: string;
  cardMessageId?: string;
  cardId?: string;
  sequence?: number;
  cardBody?: DraftCardBody;
};
export function cardDraft(draft: AutomationDraft): CardDraft { return draft; }
export function hasDraftCard(draft: AutomationDraft): boolean { return Boolean(cardDraft(draft).cardMessageId); }
export function matchesDraftCard(draft: AutomationDraft, messageId: string): boolean { return cardDraft(draft).cardMessageId === messageId; }
export function draftReceipt(draft: AutomationDraft) {
  const card = cardDraft(draft);
  return { draftId: draft.draftId, operationId: draft.operationId, deliveryId: cardDraft(draft).deliveryId,
    cardMessageId: card.cardMessageId, cardId: card.cardId };
}

export function bindCard(draft: AutomationDraft, messageId: string, cardId?: string, body?: DraftCardBody): boolean {
  const card = cardDraft(draft);
  if (cardDraft(draft).deliveryId && card.cardMessageId && card.cardMessageId !== messageId) return false;
  if (card.cardMessageId === messageId && card.cardId === cardId && card.cardBody) return true;
  card.cardMessageId = messageId;
  if (cardId) card.cardId = cardId; else delete card.cardId;
  delete card.sequence;
  if (body) card.cardBody = cloneDraftCardBody(body); else delete card.cardBody;
  return true;
}

export async function invalidateDraftCard(draft: AutomationDraft, journal: TurnJournal): Promise<void> {
  if (!cardDraft(draft).deliveryId) return;
  journal.updateDraftCard(cardDraft(draft).deliveryId!, { state: 'voided' });
  await journal.flush();
}
export type DraftCardPatch = { cardMessageId?: string | null; cardId?: string; sequence?: number };
export function patchDraftCard(draft: AutomationDraft, patch: DraftCardPatch): void {
  const card = cardDraft(draft);
  if (patch.cardMessageId === null) {
    delete cardDraft(draft).deliveryId; delete card.delivery;
    delete card.cardMessageId; delete card.cardId; delete card.sequence; delete card.cardBody;
  } else if (patch.cardMessageId !== undefined) card.cardMessageId = patch.cardMessageId;
  if (patch.cardId !== undefined) { if (patch.cardId) card.cardId = patch.cardId; else delete card.cardId; }
  if (patch.sequence !== undefined) card.sequence = patch.sequence;
}
export function resetsDraftCard(patch: UpdateDraftPatch): boolean { return (patch as DraftCardPatch).cardMessageId === null; }
export function parseCardState(raw: Record<string, unknown>) {
  if (raw.deliveryId !== undefined && (typeof raw.deliveryId !== 'string' || !/^[a-f0-9]{32}$/.test(raw.deliveryId))) throw new Error('Invalid automation delivery reference');
  const card = {
    ...(typeof raw.operationId === 'string' ? { operationId: raw.operationId } : {}),
    ...(typeof raw.deliveryId === 'string' && raw.deliveryId ? { deliveryId: raw.deliveryId } : {}),
    ...(raw.cardReply !== undefined ? { cardReply: parseDraftCardReply(raw.cardReply) } : {}),
    ...(raw.delivery !== undefined ? { delivery: parseDraftDelivery(raw.delivery) } : {}),
    ...(typeof raw.cardMessageId === 'string' && raw.cardMessageId ? { cardMessageId: raw.cardMessageId } : {}),
    ...(typeof raw.cardId === 'string' && raw.cardId ? { cardId: raw.cardId } : {}),
    ...(isFiniteNumber(raw.sequence) ? { sequence: raw.sequence } : {}),
    ...parsedCardBody(raw.cardBody),
  };
  if (raw.delivery !== undefined && (typeof raw.operationId !== 'string' || !raw.operationId)) throw new Error('Invalid automation delivery association');
  if (card.delivery?.state === 'sent' && (!card.cardMessageId || card.cardId !== card.delivery.cardId)) throw new Error('Invalid automation delivery receipt');
  if (card.delivery && card.delivery.state !== 'sent' && card.cardMessageId) throw new Error('Invalid automation delivery state');
  return card;
}
function parseDraftDelivery(raw: unknown): DraftDelivery {
  if (!isObject(raw) || typeof raw.state !== 'string' || !['prepared', 'sending', 'sent', 'rejected'].includes(raw.state)
    || typeof raw.deliveryId !== 'string' || !/^[a-f0-9]{32}$/.test(raw.deliveryId) || !isObject(raw.card)
    || (raw.cardId !== undefined && (typeof raw.cardId !== 'string' || !raw.cardId))
    || ((raw.state === 'sending' || raw.state === 'sent') && !raw.cardId)) throw new Error('Invalid automation draft delivery');
  return { state: raw.state as DraftDelivery['state'], deliveryId: raw.deliveryId, card: structuredClone(raw.card), ...(raw.cardId ? { cardId: raw.cardId as string } : {}) };
}
function parsedCardBody(raw: unknown): { cardBody: DraftCardBody } | undefined {
  const cardBody = parseDraftCardBody(raw);
  return cardBody ? { cardBody } : undefined;
}
export function cloneDraft(input: AutomationDraft): AutomationDraft {
  let draft = cardDraft(input);
  draft = { ...draft, ...(draft.cardReply ? { cardReply: { ...draft.cardReply } } : {}), ...(cardDraft(draft).delivery ? { delivery: structuredClone(cardDraft(draft).delivery) } : {}) };
  const cardBody = draft.cardBody ? { cardBody: cloneDraftCardBody(draft.cardBody) } : {};
  switch (draft.op) {
    case 'delete':
      return { ...draft, target: { ...draft.target }, ...cardBody };
    case 'replace':
      return { ...draft, target: { ...draft.target }, ...cardBody };
    case 'create':
      return { ...draft, ...cardBody };
    default: {
      const _exhaustive: never = draft;
      return _exhaustive;
    }
  }
}
export async function migrateDraftCards(drafts: AutomationDraft[], journal: TurnJournal): Promise<boolean> {
  let upgraded = false;
  // Journal first, automations second: either crash point can repeat the
  // transfer by deliveryId without losing or resetting an unknown send.
  for (const input of drafts) {
    const draft = cardDraft(input);
    const delivery = draft.delivery;
    if (!delivery) continue;
    journal.stageDraftCard({
      kind: 'draft-card', deliveryId: delivery.deliveryId,
      state: delivery.state === 'prepared' || delivery.state === 'sending' ? 'staged' : delivery.state,
      createdAt: draft.createdAt, target: { chatId: draft.chatId, ...draft.cardReply },
      payload: { draftId: draft.draftId, card: delivery.card },
      ...(delivery.cardId ? { cardId: delivery.cardId } : {}),
      ...(delivery.state === 'sent' && draft.cardMessageId ? { receipt: { messageId: draft.cardMessageId, cardId: delivery.cardId } } : {}),
    });
    draft.deliveryId = delivery.deliveryId;
    delete draft.delivery;
  }
  const stagedCards = journal.listDraftCards().filter(item => item.state === 'staged');
  for (const input of drafts) {
    const draft = cardDraft(input);
    if (cardDraft(draft).deliveryId) continue;
    const candidates = stagedCards.filter(item => item.payload.draftId === draft.draftId && item.target.chatId === draft.chatId);
    if (candidates.length > 1) throw new Error('Invalid ambiguous automation delivery reference');
    const item = candidates[0];
    if (!item) continue;
    cardDraft(draft).deliveryId = item.deliveryId;
    const cardReply = draftCardReply(item);
    if (cardReply) draft.cardReply = cardReply;
    upgraded = true;
  }
  for (const input of drafts) {
    const draft = cardDraft(input);
    if (!cardDraft(draft).deliveryId) continue;
    const item = journal.getDraftCard(cardDraft(draft).deliveryId!);
    if (!item || item.payload.draftId !== draft.draftId || item.target.chatId !== draft.chatId) throw new Error('Invalid automation delivery reference');
  }
  await journal.flush();
  return upgraded;
}
export function draftCardReply(item: DraftCardItem): DraftCardReply | undefined {
  const target = item.target;
  return target.replyTo ? { replyTo: target.replyTo,
    ...(target.replyInThread ? { replyInThread: true } : {}),
    ...(target.threadId ? { threadId: target.threadId } : {}),
  } : undefined;
}

function isObject(raw: unknown): raw is Record<string, unknown> { return !!raw && typeof raw === 'object' && !Array.isArray(raw); }
function isFiniteNumber(raw: unknown): raw is number { return typeof raw === 'number' && Number.isFinite(raw); }
function parseDraftCardReply(raw: unknown): DraftCardReply {
  if (!isObject(raw) || typeof raw.replyTo !== 'string' || !raw.replyTo
    || (raw.replyInThread !== undefined && typeof raw.replyInThread !== 'boolean')
    || (raw.threadId !== undefined && (typeof raw.threadId !== 'string' || !raw.threadId))
    || (raw.replyInThread === true && !raw.threadId)) throw new Error('Invalid automation card reply');
  return { replyTo: raw.replyTo, ...(raw.replyInThread === true ? { replyInThread: true } : {}), ...(raw.threadId ? { threadId: raw.threadId as string } : {}) };
}

export function getDraftDelivery(draft: AutomationDraft, journal: TurnJournal): DraftDelivery | undefined {
  const id = cardDraft(draft).deliveryId;
  const item = id ? journal.getDraftCard(id) : undefined;
  if (!item || item.state === 'voided') return undefined;
  return { state: item.state === 'staged' ? (item.cardId ? 'sending' : 'prepared') : item.state,
    deliveryId: item.deliveryId, card: item.payload.card, ...(item.cardId ? { cardId: item.cardId } : {}) };
}
export function associateDraftDelivery(draft: AutomationDraft | undefined, item: DraftCardItem | undefined, deliveryId: string): void {
  if (!draft || item?.payload.draftId !== draft.draftId) throw new Error('Draft Outbox association unavailable');
  const card = cardDraft(draft);
  if (card.deliveryId && card.deliveryId !== deliveryId) throw new Error('Draft Outbox association conflict');
  card.deliveryId = deliveryId;
  const reply = draftCardReply(item);
  if (reply) draft.cardReply = reply;
}
export function viewDraft(draft: AutomationDraft, journal: TurnJournal): AutomationDraft {
  const view = cardDraft(cloneDraft(draft));
  const delivery = getDraftDelivery(draft, journal);
  if (delivery) view.delivery = delivery;
  return view;
}
export async function bindDraftReceipt(draft: AutomationDraft, journal: TurnJournal, messageId: string, cardId?: string, body?: DraftCardBody): Promise<boolean> {
  if (!bindCard(draft, messageId, cardId, body)) return false;
  const deliveryId = cardDraft(draft).deliveryId;
  if (deliveryId) {
    journal.updateDraftCard(deliveryId, { receipt: { messageId, ...(cardId ? { cardId } : {}) } });
    await journal.flush();
  }
  return true;
}
export function serializeDraft(draft: AutomationDraft): AutomationDraft {
  const { delivery: _delivery, ...stored } = cardDraft(cloneDraft(draft));
  return stored;
}
export function draftHasUnknownDelivery(draft: AutomationDraft): boolean { return cardDraft(draft).delivery?.state === 'sending'; }
