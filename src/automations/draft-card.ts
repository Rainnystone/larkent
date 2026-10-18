import type { LarkChannel } from '@larksuite/channel';
import { updateCardByCardId } from '../card/cardkit-update';
import { readCardApiError } from '../card/card-api-error';
import { card2, md } from '../card/v2';
import { log } from '../core/logger';
import type { AutomationDraft, AutomationsStore } from './store';

export const DRAFT_SETTLED_CANCELLED = '已取消';
export const DRAFT_SETTLED_EXPIRED = '已过期';
export const DRAFT_SETTLED_END_CHOSEN = '已指定结束时间';

export function draftConfirmedStatus(id: number): string {
  return `已确认 #${id}`;
}

export function automationSettledCard(status: string): object {
  return card2({
    title: status,
    summary: status,
    elements: [md(status)],
  });
}

export async function settleDraftCard(
  channel: LarkChannel,
  draft: Pick<AutomationDraft, 'draftId' | 'cardMessageId' | 'cardId' | 'sequence'>,
  status: string,
  store?: AutomationsStore,
): Promise<void> {
  if (!draft.cardMessageId) return;
  const card = automationSettledCard(status);
  if (draft.cardId) {
    const sequence = (draft.sequence ?? 0) + 1;
    await updateCardByCardId(channel, draft.cardId, card, sequence);
    const live = store?.getDraft(draft.draftId);
    if (store && live?.cardId === draft.cardId) {
      await store.updateDraft(draft.draftId, { sequence });
    }
    return;
  }
  await channel.updateCard(draft.cardMessageId, card);
}

export async function expireDueDraftCards(input: {
  store: AutomationsStore;
  channel: LarkChannel;
}): Promise<void> {
  for (const draft of input.store.listExpiredDrafts()) {
    try {
      await settleDraftCard(input.channel, draft, DRAFT_SETTLED_EXPIRED, input.store);
    } catch (error) {
      logDraftCardFail(draft.draftId, error);
      continue;
    }
    await input.store.takeDraft(draft.draftId);
  }
}

export function scheduleDraftCardSettle(
  channel: LarkChannel,
  draft: Pick<AutomationDraft, 'draftId' | 'cardMessageId' | 'cardId' | 'sequence'>,
  status: string,
  store?: AutomationsStore,
): void {
  setImmediate(() => {
    void settleDraftCard(channel, draft, status, store).catch((error: unknown) => {
      logDraftCardFail(draft.draftId, error);
    });
  });
}

function logDraftCardFail(draftId: string, error: unknown): void {
  const api = readCardApiError(error);
  log.fail('auto', error, {
    event: 'draft-card',
    draftId,
    ...(api.code !== undefined ? { code: api.code } : {}),
    ...(api.msg !== undefined ? { msg: api.msg } : {}),
  });
}
