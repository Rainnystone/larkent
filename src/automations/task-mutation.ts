import type { AutomationScheduler } from './scheduler';
import { nextFireAfter, readSchedule } from './schedule';
import { taskMutationError, type AutomationsStore, type TaskMutationGuard } from './store';

export type ImmediateTaskMutation = 'pause' | 'resume' | 'delete';
export const taskMutationLabels = { pause: '暂停', resume: '恢复', delete: '删除' } as const;

/** Commands, board actions and tool receipts enter the same current-target business path. */
export async function mutateAutomationTask(
  context: { store: AutomationsStore; scheduler: AutomationScheduler; chatId: string; now?: () => number },
  operation: ImmediateTaskMutation,
  id: number,
  guard?: TaskMutationGuard,
) {
  const item = context.store.get(id);
  const code = taskMutationError(item, { ...guard, chatId: context.chatId });
  if (code || !item) return { ok: false as const, code: code ?? 'target-not-found' };
  if (operation === 'resume' && guard?.operation) {
    const schedule = readSchedule(item.schedule);
    if (!schedule || !nextFireAfter(schedule, (context.now ?? Date.now)())) return { ok: false as const, code: 'no-remaining-fires' };
  }
  const ok = guard ? await context.scheduler[operation](id, guard) : await context.scheduler[operation](id);
  return ok ? { ok: true as const, item } : { ok: false as const, code: taskMutationError(context.store.get(id), { ...guard, chatId: context.chatId }) ?? 'no-remaining-fires' };
}
