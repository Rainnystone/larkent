import type { LarkChannel } from '@larksuite/channel';
import { classify, isGoneMessage } from '../bot/feishu-error';
import { updateCardByCardId } from '../card/cardkit-update';
import { readCardApiError } from '../card/card-api-error';
import { card2, md } from '../card/v2';
import { log } from '../core/logger';
import { renderSettledCard } from './card-body';
import { monotonicCardSequence } from './card-sequence';
import type { AutomationDraft, AutomationsStore } from './store';

export const DRAFT_SETTLED_CANCELLED = '已取消';
export const DRAFT_SETTLED_EXPIRED = '已过期';
export const DRAFT_SETTLED_END_CHOSEN = '已指定结束时间';
export const DRAFT_SETTLE_RETRY_ATTEMPTS = 3;
export const DRAFT_SETTLE_RETRY_MIN_MS = 1_000;

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

export type DraftCardRef = Pick<AutomationDraft, 'draftId' | 'cardMessageId' | 'cardId' | 'sequence' | 'cardBody'>;

export async function settleDraftCard(
  channel: LarkChannel,
  draft: DraftCardRef,
  status: string,
  store?: AutomationsStore,
  now: () => number = Date.now,
): Promise<void> {
  if (!draft.cardMessageId) return;
  const card = draft.cardBody ? renderSettledCard(draft.cardBody, status) : automationSettledCard(status);
  if (draft.cardId) {
    const sequence = monotonicCardSequence(draft.sequence, now());
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
      if (isPermanentDraftCardError(error)) {
        await input.store.takeDraft(draft.draftId);
      }
      continue;
    }
    await input.store.takeDraft(draft.draftId);
  }
}

export function scheduleDraftCardSettle(
  channel: LarkChannel,
  draft: DraftCardRef,
  status: string,
  store?: AutomationsStore,
): void {
  setImmediate(() => {
    void settleDraftCardWithRetry(channel, draft, status, store);
  });
}

async function settleDraftCardWithRetry(
  channel: LarkChannel,
  draft: DraftCardRef,
  status: string,
  store: AutomationsStore | undefined,
): Promise<void> {
  for (let attempt = 0; attempt < DRAFT_SETTLE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await settleDraftCard(channel, draft, status, store);
      return;
    } catch (error) {
      if (isPermanentDraftCardError(error) || attempt === DRAFT_SETTLE_RETRY_ATTEMPTS - 1) {
        logDraftCardFail(draft.draftId, error);
        return;
      }
      await wait(DRAFT_SETTLE_RETRY_MIN_MS * (2 ** attempt));
    }
  }
}

function isPermanentDraftCardError(error: unknown): boolean {
  return isGoneMessage(error) || classify(error) === 'rejected';
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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
