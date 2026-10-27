import { automationTargetSnapshot } from './confirm-card';
import { submitDraft, type DraftConfirmationContext } from './draft-confirmation';
import type { AutomationScheduler } from './scheduler';
import { nextFireAfter, readSchedule, type PendingRecurring } from './schedule';
import { automationTargetRevision, type AutomationItem, type AutomationsStore, type CreateAutomationInput, type DraftCardReply, type RegisterAutomationOperationInput, type TaskMutationReceipt } from './store';

export type ImmediateTaskMutation = 'pause' | 'resume' | 'delete';
export const taskMutationLabels = { pause: '暂停', resume: '恢复', delete: '删除' } as const;
type Replacement = CreateAutomationInput & { pendingRecurring?: PendingRecurring };
type TaskMutation = { operation: ImmediateTaskMutation } | { operation: 'replace'; replacement: Replacement };
type Actor = { actor: 'human'; confirmation?: { draftId: string; operationId?: string } }
  | { actor: 'model'; createdBy: string; registration: RegisterAutomationOperationInput; drafts: DraftConfirmationContext; cardReply?: DraftCardReply };
export type AutomationTaskMutation = TaskMutation & Actor & { id: number; revision?: string };

/** Human direct actions apply immediately. Models confirm delete/replace; pause/resume stay immediate. */
export function automationMutationNeedsConfirmation(actor: Actor['actor'], operation: TaskMutation['operation']): boolean {
  return actor === 'model' && (operation === 'delete' || operation === 'replace');
}

/** Callers select live management state or committed receipt/list state explicitly. */
export function readAutomationTasks(store: AutomationsStore, query: { chatId: string; consistency: 'live' | 'committed' }): AutomationItem[] {
  return (query.consistency === 'committed' ? store.listCommitted() : store.list()).filter(item => item.chatId === query.chatId);
}

export function readAutomationTask(store: AutomationsStore, query: { chatId: string; id: number; revision?: string; consistency: 'live' | 'committed' }) {
  const item = query.consistency === 'live' ? store.get(query.id)
    : readAutomationTasks(store, query).find(item => item.id === query.id);
  if (!item || item.chatId !== query.chatId) return { ok: false as const, code: 'target-not-found' };
  if (query.revision && query.revision !== automationTargetRevision(item)) return { ok: false as const, code: 'target-state-conflict' };
  return { ok: true as const, item };
}

export async function mutateAutomationTask(
  context: { store: AutomationsStore; scheduler: AutomationScheduler; chatId: string },
  request: AutomationTaskMutation,
) {
  const { store, scheduler, chatId } = context;
  const query = { chatId, id: request.id, revision: request.revision, consistency: 'live' as const };
  const target = readAutomationTask(store, query);
  if (!target.ok) return target;
  if (request.actor === 'model') query.revision ??= automationTargetRevision(target.item);
  if (automationMutationNeedsConfirmation(request.actor, request.operation) && request.actor === 'model') {
    if (!request.drafts.autoAuth) return { ok: false as const, code: 'automation-confirmation-unavailable', category: 'unavailable' as const };
    const common = { operationId: request.registration.operationId, cardReply: request.cardReply, chatId, createdBy: request.createdBy,
      targetId: target.item.id, target: automationTargetSnapshot(target.item) };
    if (request.operation === 'replace') {
      await submitDraft(request.drafts, { ...request.replacement, ...common, op: 'replace' }, request.registration);
    } else {
      await submitDraft(request.drafts, { ...common, op: 'delete' }, request.registration);
    }
    return { ok: true as const, item: target.item };
  }
  return scheduler.updateTasks(async now => {
    // Read again inside the scheduler queue: a due fire or another action may have run while waiting.
    const current = readAutomationTask(store, query);
    if (!current.ok) return current;
    const receipt: TaskMutationReceipt | undefined = request.actor === 'model' ? { operation: request.registration }
      : request.confirmation ? { confirmedDraftId: request.confirmation.draftId, operationId: request.confirmation.operationId } : undefined;
    const item = current.item;
    if (request.operation === 'replace') {
      const created = await store.replace(item.id, request.replacement, receipt);
      return created ? { ok: true as const, item: created } : { ok: false as const, code: 'target-not-found' };
    }
    let ok: boolean;
    if (request.operation === 'resume') {
      const schedule = readSchedule(item.schedule);
      const next = schedule ? nextFireAfter(schedule, now) : 0;
      if (request.actor === 'model' && !next) return { ok: false as const, code: 'no-remaining-fires' };
      ok = await store.resume(item.id, next, receipt);
      if (ok && !next) await store.delete(item.id);
    } else {
      ok = await store[request.operation](item.id, receipt);
    }
    return ok ? { ok: true as const, item } : { ok: false as const, code: 'target-not-found' };
  });
}
