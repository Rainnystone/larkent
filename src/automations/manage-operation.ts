import { createHash } from 'node:crypto';
import { toolResult, type ToolResult } from '../bridge-tools/protocol';
import { AUTOMATION_OPERATION_TTL_MS, readAutomationOperationId } from './operation-id';
import { checkId, getReminderOperation, unknown } from './reminder-operation';
import { flushDraftCardOnce } from './command';
import { automationTargetSnapshot } from './confirm-card';
import { automationTargetRevision, taskMutationError } from './store';
import { normalizeAutomationSchedule } from './schedule-input';
import { nextFireAfter, readSchedule } from './schedule';
import type { AutomationToolContext } from './tools';

export async function manageAutomationOperation(operation: string, params: Record<string, unknown>, context: AutomationToolContext): Promise<ToolResult> {
  const invalid = checkId(params.operationId, context);
  if (invalid) return invalid;
  const operationId = params.operationId as string;
  if (Object.keys(params).some(key => !(operation === 'automation.replace' ? ['id', 'operationId', 'revision', 'taskType', 'name', 'taskText', 'schedule', 'timezone'] : ['id', 'operationId', 'revision']).includes(key))) return toolResult('validation-failed', 'unknown-field');
  if (!Number.isSafeInteger(params.id) || (params.id as number) < 1) return toolResult('validation-failed', 'invalid-task-id');
  if (readAutomationOperationId(operationId)!.issuedAt + AUTOMATION_OPERATION_TTL_MS <= (context.now ?? Date.now)()) return toolResult('validation-failed', 'operation-expired', { operationId });
  const scheduler = context.drafts?.automationsScheduler;
  if (!scheduler) return toolResult('unavailable', 'automation-scheduler-unavailable');
  try {
    const previous = context.store!.getOperation(operationId);
    let replacement: (import('./store').CreateAutomationInput & { pendingRecurring?: import('./schedule').PendingRecurring }) | undefined;
    if (operation === 'automation.replace') {
      const missing = ['name', 'taskText'].filter(key => params[key] === undefined);
      if (missing.length) return toolResult('needs-input', 'missing-fields', { fields: missing, operationId });
      if (typeof params.name !== 'string' || !params.name.trim() || typeof params.taskText !== 'string' || !params.taskText.trim()) return toolResult('validation-failed', 'invalid-task-content', { operationId });
      const normalized = normalizeAutomationSchedule(params, { ...context, now: () => previous?.createdAt ?? (context.now ?? Date.now)() }, true);
      if (!normalized.ok) return normalized.result;
      const pending = 'pendingRecurring' in normalized ? normalized.pendingRecurring : undefined;
      const schedule = 'schedule' in normalized ? normalized.schedule : undefined;
      const cwd = params.taskType === 'agent' ? context.cwd : undefined;
      if (params.taskType === 'agent' && !cwd?.trim()) return toolResult('unavailable', 'agent-needs-cwd');
      replacement = { taskType: params.taskType as 'agent' | 'reminder', schedule: pending ?? schedule!, ...(pending ? { pendingRecurring: pending } : {}), timezone: normalized.timezone,
        startAt: 'pendingRecurring' in normalized ? normalized.startAt : normalized.schedule.kind === 'one-shot' ? normalized.schedule.fireAt : normalized.schedule.startAt,
        ...(schedule ? { endAt: schedule.kind === 'one-shot' ? schedule.fireAt : schedule.endAt } : {}),
        nextFireAt: schedule ? nextFireAfter(schedule, (context.now ?? Date.now)()) : 0, name: params.name.trim(), taskText: params.taskText.trim(), cwd, chatId: context.chatId, createdBy: context.actorId };
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ operation, id: params.id, revision: params.revision, ...(replacement ? { replacement: { taskType: replacement.taskType, name: replacement.name, taskText: replacement.taskText, timezone: replacement.timezone, startAt: replacement.startAt, endAt: replacement.endAt ?? null, schedule: replacement.schedule } } : {}) })).digest('hex');
    if (previous) return previous.fingerprint === fingerprint ? getReminderOperation(operationId, context) : toolResult('validation-failed', 'operation-conflict', { operationId });
    if (params.revision !== undefined && (typeof params.revision !== 'string' || !/^[a-f0-9]{64}$/.test(params.revision))) return toolResult('validation-failed', 'invalid-target-revision');
    const item = context.store!.get(params.id as number);
    const reusable = context.store!.findReusableOperation(context.profile, context.chatId, fingerprint);
    if (reusable && (operation === 'automation.delete' || operation === 'automation.replace'
      || (item?.chatId === context.chatId && item.paused === (operation === 'automation.pause')))) {
      await context.store!.aliasOperation(reusable.operationId, operationId);
      const result = await getReminderOperation(operationId, context);
      return result.category === 'unknown' ? { ...result, code: 'prior-operation-unknown' } : result;
    }
    const registration = { operationId, fingerprint, profile: context.profile, chatId: context.chatId };
    const fail = async (code: string) => { await context.store!.recordOperationFailure(registration, code); return getReminderOperation(operationId, context); };
    const targetError = taskMutationError(item, { chatId: context.chatId, revision: params.revision as string | undefined });
    if (targetError) return fail(targetError);
    if (!item || item.chatId !== context.chatId) return toolResult('execution-failed', 'target-not-found', { operationId, state: 'not-applied', applied: false });
    if (replacement) {
      if (!context.drafts?.autoAuth) return toolResult('unavailable', 'automation-confirmation-unavailable');
      const draft = await context.store!.saveDraft({ ...replacement, op: 'replace', operationId, cardReply: context.cardReply,
        targetId: item.id, target: automationTargetSnapshot(item) }, registration);
      await flushDraftCardOnce(context.drafts, draft.draftId, (context.now ?? Date.now)());
      return getReminderOperation(operationId, context);
    }
    if (operation === 'automation.delete') {
      if (!context.drafts?.autoAuth) return toolResult('unavailable', 'automation-confirmation-unavailable');
      const draft = await context.store!.saveDraft({ op: 'delete', operationId, cardReply: context.cardReply, chatId: context.chatId, createdBy: context.actorId,
        targetId: item.id, target: automationTargetSnapshot(item) }, registration);
      await flushDraftCardOnce(context.drafts, draft.draftId, (context.now ?? Date.now)());
      return getReminderOperation(operationId, context);
    }
    if (operation === 'automation.resume') {
      const schedule = readSchedule(item.schedule);
      if (!schedule || !nextFireAfter(schedule, (context.now ?? Date.now)())) return fail('no-remaining-fires');
    }
    const ok = operation === 'automation.resume' ? await scheduler.resume(item.id, { chatId: context.chatId, revision: automationTargetRevision(item), operation: registration }) : await scheduler.pause(item.id, { chatId: context.chatId, revision: automationTargetRevision(item), operation: registration });
    if (!ok) return fail(taskMutationError(context.store!.get(item.id), { chatId: context.chatId, revision: automationTargetRevision(item) }) ?? 'no-remaining-fires');
    return getReminderOperation(operationId, context);
  } catch { return unknown(operationId, 'persistence-or-delivery-unknown'); }
}
