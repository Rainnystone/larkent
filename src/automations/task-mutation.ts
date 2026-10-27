import { automationTargetSnapshot } from './confirm-card';
import { submitDraft, type DraftConfirmationContext } from './draft-confirmation';
import type { AutomationScheduler } from './scheduler';
import { nextFireAfter, readSchedule, type PendingRecurring } from './schedule';
import { taskMutationError, type AutomationsStore, type CreateAutomationInput, type DraftCardReply, type RegisterAutomationOperationInput, type TaskMutationGuard } from './store';

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

export async function mutateAutomationTask(
  context: { store: AutomationsStore; scheduler: AutomationScheduler; chatId: string; now?: () => number },
  request: AutomationTaskMutation,
) {
  const { store, scheduler, chatId } = context;
  const item = store.get(request.id);
  const guard: TaskMutationGuard = { chatId, revision: request.revision,
    ...(request.actor === 'model' ? { operation: request.registration } : request.confirmation
      ? { confirmedDraftId: request.confirmation.draftId, operationId: request.confirmation.operationId } : {}) };
  const code = taskMutationError(item, guard);
  if (code || !item) return { ok: false as const, code: code ?? 'target-not-found' };
  if (automationMutationNeedsConfirmation(request.actor, request.operation) && request.actor === 'model') {
    if (!request.drafts.autoAuth) return { ok: false as const, code: 'automation-confirmation-unavailable', category: 'unavailable' as const };
    const common = { operationId: request.registration.operationId, cardReply: request.cardReply, chatId, createdBy: request.createdBy,
      targetId: item.id, target: automationTargetSnapshot(item) };
    if (request.operation === 'replace') {
      await submitDraft(request.drafts, { ...request.replacement, ...common, op: 'replace' }, request.registration);
    } else {
      await submitDraft(request.drafts, { ...common, op: 'delete' }, request.registration);
    }
    return { ok: true as const, item };
  }
  if (request.operation === 'replace') throw new Error('confirmed replacement requires replacement draft');
  if (request.operation === 'resume' && request.actor === 'model') {
    const schedule = readSchedule(item.schedule);
    if (!schedule || !nextFireAfter(schedule, (context.now ?? Date.now)())) return { ok: false as const, code: 'no-remaining-fires' };
  }
  const ok = await scheduler[request.operation](request.id, guard);
  return ok ? { ok: true as const, item } : { ok: false as const, code: taskMutationError(store.get(request.id), guard) ?? 'no-remaining-fires' };
}
