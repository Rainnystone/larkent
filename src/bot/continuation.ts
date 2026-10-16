import type { NormalizedMessage } from '@larksuite/channel';
import {
  abandonExtraInstruction,
  continueExtraInstruction,
  isContinuePrompt,
  resolveInterruptionNotice,
  type NoticeCardUpdater,
} from './interruption-notice';
import type { RunOutcome } from './run-outcome';
import type {
  ContinuationStatus,
  TurnJournal,
  TurnJournalEntry,
  TurnJournalResource,
} from './turn-journal';

export type ContinuationTaken =
  | { kind: 'none' }
  | {
      kind: 'continue';
      turnId: string;
      resumeHandle?: string;
      userInput?: string;
      instruction: string;
      policyFingerprint?: string;
      resources?: TurnJournalResource[];
    }
  | { kind: 'abandoned'; turnId: string; instruction: string };

export interface Continuations {
  offer(turnId: string, outcome: RunOutcome): void;
  click(turnId: string): boolean;
  take(scope: string, batch: NormalizedMessage[]): Promise<ContinuationTaken>;
  dismiss(turnId: string): void;
  voidScope(scope: string): void;
  consecutive(scope: string): number;
}

const FALLBACK_OUTCOME: RunOutcome = {
  kind: 'interrupted',
  reason: { type: 'external-signal' },
  retriable: true,
  needsHuman: false,
};

export function createContinuations(deps: {
  journal?: TurnJournal;
  updateCard?: NoticeCardUpdater;
}): Continuations {
  const streakByScope = restoreStreaks(deps.journal);

  function consecutive(scope: string): number {
    return streakByScope.get(scope) ?? 0;
  }

  function offer(turnId: string, _outcome: RunOutcome): void {
    const journal = deps.journal;
    if (!journal) return;
    const entry = journal.get(turnId);
    if (!entry) return;
    const status = continuationStatus(entry);
    if (status !== undefined) return;
    const next = consecutive(entry.scope) + 1;
    streakByScope.set(entry.scope, next);
    journal.update(turnId, {
      continuation: { status: 'offered' },
      consecutiveInterrupts: next,
    });
  }

  function click(turnId: string): boolean {
    const journal = deps.journal;
    if (!journal) return false;
    const entry = journal.get(turnId);
    if (!entry) return false;
    if (continuationStatus(entry) !== 'offered') return false;
    journal.update(turnId, { continuation: { status: 'continue-requested' } });
    return true;
  }

  async function take(scope: string, batch: NormalizedMessage[]): Promise<ContinuationTaken> {
    const journal = deps.journal;
    if (!journal) return { kind: 'none' };
    const requested = latestWithStatus(journal, scope, 'continue-requested');
    const offered = latestWithStatus(journal, scope, 'offered');
    const last = batch[batch.length - 1];
    const dismissed = latestWithStatus(journal, scope, 'dismissed');
    if (requested) return finishContinue(journal, requested);
    if (offered && last && isContinuePrompt(last.content)) {
      return finishContinue(journal, offered);
    }
    if (offered) return finishAbandon(journal, offered, true);
    if (dismissed && !(last && isContinuePrompt(last.content))) {
      return finishAbandon(journal, dismissed, false);
    }
    streakByScope.set(scope, 0);
    return { kind: 'none' };
  }

  async function finishContinue(
    journal: TurnJournal,
    entry: TurnJournalEntry,
  ): Promise<Extract<ContinuationTaken, { kind: 'continue' }>> {
    journal.update(entry.turnId, {
      continuation: { status: 'continued' },
      noticeInvalidated: true,
    });
    await resolveInterruptionNotice({
      journal,
      turnId: entry.turnId,
      resolution: 'continued',
      updateCard: deps.updateCard,
    });
    const userInput = entry.userInput;
    return {
      kind: 'continue',
      turnId: entry.turnId,
      ...(entry.resumeHandle ? { resumeHandle: entry.resumeHandle } : {}),
      ...(userInput ? { userInput } : {}),
      instruction: continueExtraInstruction(outcomeOf(entry), userInput),
      ...(entry.policyFingerprint ? { policyFingerprint: entry.policyFingerprint } : {}),
      ...(entry.resources ? { resources: entry.resources } : {}),
    };
  }

  async function finishAbandon(
    journal: TurnJournal,
    entry: TurnJournalEntry,
    updateCard: boolean,
  ): Promise<Extract<ContinuationTaken, { kind: 'abandoned' }>> {
    streakByScope.set(entry.scope, 0);
    journal.update(entry.turnId, {
      continuation: { status: 'abandoned' },
      noticeInvalidated: true,
    });
    voidOtherOpenOffers(journal, entry.scope, entry.turnId);
    if (updateCard) {
      await resolveInterruptionNotice({
        journal,
        turnId: entry.turnId,
        resolution: 'abandoned',
        updateCard: deps.updateCard,
      });
    }
    return {
      kind: 'abandoned',
      turnId: entry.turnId,
      instruction: abandonExtraInstruction(outcomeOf(entry)),
    };
  }

  function dismiss(turnId: string): void {
    const journal = deps.journal;
    if (!journal) return;
    const entry = journal.get(turnId);
    if (!entry) return;
    const status = continuationStatus(entry);
    if (status !== 'offered' && status !== 'continue-requested') return;
    journal.update(turnId, {
      continuation: { status: 'dismissed' },
      noticeInvalidated: true,
    });
  }

  function voidScope(scope: string): void {
    streakByScope.set(scope, 0);
    const journal = deps.journal;
    if (!journal) return;
    for (const entry of journal.list()) {
      if (entry.scope !== scope) continue;
      const status = continuationStatus(entry);
      if (status !== 'offered' && status !== 'continue-requested') continue;
      journal.update(entry.turnId, {
        continuation: { status: 'voided' },
        noticeInvalidated: true,
      });
    }
    journal.voidScope(scope);
  }

  return { offer, click, take, dismiss, voidScope, consecutive };
}

function continuationStatus(entry: TurnJournalEntry): ContinuationStatus | undefined {
  if (entry.continuation?.status) return entry.continuation.status;
  if (entry.noticeInvalidated) return 'voided';
  if (isLegacyOffer(entry)) return 'offered';
  return undefined;
}

function isLegacyOffer(entry: TurnJournalEntry): boolean {
  if (entry.noticeInvalidated) return false;
  if (entry.notice?.kind !== 'continue' && entry.notice?.kind !== 'plain') return false;
  return entry.status === 'notice-delivered' || entry.status === 'notice-pending';
}

function latestWithStatus(
  journal: TurnJournal,
  scope: string,
  status: ContinuationStatus,
): TurnJournalEntry | undefined {
  return [...journal.list()].reverse().find((entry) => (
    entry.scope === scope && continuationStatus(entry) === status
  ));
}

function voidOtherOpenOffers(journal: TurnJournal, scope: string, keepTurnId: string): void {
  for (const entry of journal.list()) {
    if (entry.scope !== scope || entry.turnId === keepTurnId) continue;
    const status = continuationStatus(entry);
    if (status !== 'offered' && status !== 'continue-requested') continue;
    journal.update(entry.turnId, {
      continuation: { status: 'voided' },
      noticeInvalidated: true,
    });
  }
}

function outcomeOf(entry: TurnJournalEntry): RunOutcome {
  return entry.outcome ?? FALLBACK_OUTCOME;
}

function restoreStreaks(journal?: TurnJournal): Map<string, number> {
  const map = new Map<string, number>();
  if (!journal) return map;
  for (const entry of journal.list()) {
    const status = continuationStatus(entry);
    switch (status) {
      case 'abandoned':
      case 'voided':
      case 'dismissed':
        map.set(entry.scope, 0);
        continue;
      case 'offered':
      case 'continue-requested':
      case 'continued':
      case undefined:
        break;
      default: {
        const _exhaustive: never = status;
        return _exhaustive;
      }
    }
    if (typeof entry.consecutiveInterrupts === 'number') {
      map.set(entry.scope, entry.consecutiveInterrupts);
    }
    if (entry.status === 'reply-delivered' && entry.outcome?.kind === 'completed') {
      map.set(entry.scope, 0);
    }
  }
  return map;
}
