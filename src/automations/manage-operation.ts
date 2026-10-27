import { createHash } from 'node:crypto';
import { toolResult, type ToolResult } from '../bridge-tools/protocol';
import { resolveWorkingDirectory } from '../policy/workspace';
import { AUTOMATION_OPERATION_TTL_MS, readAutomationOperationId } from './operation-id';
import { validateAutomationOperationId, getAutomationOperation, unknownAutomationOperation } from './operation';
import { normalizeAutomationSchedule } from './schedule-input';
import { mutateAutomationTask, readAutomationTask } from './task-mutation';
import { nextFireAfter } from './schedule';
import type { AutomationToolContext } from './tools';

export async function manageAutomationOperation(operation: string, params: Record<string, unknown>, context: AutomationToolContext): Promise<ToolResult> {
  const invalid = validateAutomationOperationId(params.operationId, context);
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
      const cwd = params.taskType === 'agent' ? context.cwd?.trim() : undefined;
      if (params.taskType === 'agent' && !cwd) return toolResult('unavailable', 'agent-needs-cwd');
      replacement = { taskType: params.taskType as 'agent' | 'reminder', schedule: pending ?? schedule!, ...(pending ? { pendingRecurring: pending } : {}), timezone: normalized.timezone,
        startAt: 'pendingRecurring' in normalized ? normalized.startAt : normalized.schedule.kind === 'one-shot' ? normalized.schedule.fireAt : normalized.schedule.startAt,
        ...(schedule ? { endAt: schedule.kind === 'one-shot' ? schedule.fireAt : schedule.endAt } : {}),
        nextFireAt: schedule ? nextFireAfter(schedule, (context.now ?? Date.now)()) : 0, name: params.name.trim(), taskText: params.taskText.trim(), ...(cwd ? { cwd } : {}), chatId: context.chatId, createdBy: context.actorId };
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ operation, id: params.id, revision: params.revision, ...(replacement ? { replacement: { taskType: replacement.taskType, ...(replacement.cwd ? { cwd: replacement.cwd } : {}), name: replacement.name, taskText: replacement.taskText, timezone: replacement.timezone, startAt: replacement.startAt, endAt: replacement.endAt ?? null, schedule: replacement.schedule } } : {}) })).digest('hex');
    if (previous) return previous.fingerprint === fingerprint ? getAutomationOperation(operationId, context) : toolResult('validation-failed', 'operation-conflict', { operationId });
    if (params.revision !== undefined && (typeof params.revision !== 'string' || !/^[a-f0-9]{64}$/.test(params.revision))) return toolResult('validation-failed', 'invalid-target-revision');
    const target = readAutomationTask(context.store!, { id: params.id as number, chatId: context.chatId, consistency: 'committed' });
    const item = target.ok ? target.item : undefined;
    const reusable = context.store!.findReusableOperation(context.profile, context.chatId, fingerprint);
    if (reusable && (operation === 'automation.delete' || operation === 'automation.replace'
      || (item?.chatId === context.chatId && item.paused === (operation === 'automation.pause')))) {
      await context.store!.aliasOperation(reusable.operationId, operationId);
      const result = await getAutomationOperation(operationId, context);
      return result.category === 'unknown' ? { ...result, code: 'prior-operation-unknown' } : result;
    }
    const registration = { operationId, fingerprint, profile: context.profile, chatId: context.chatId };
    const fail = async (code: string) => { await context.store!.recordOperationFailure(registration, code); return getAutomationOperation(operationId, context); };
    const current = readAutomationTask(context.store!, { id: params.id as number, chatId: context.chatId, revision: params.revision as string | undefined, consistency: 'live' });
    if (!current.ok) return fail(current.code);
    if (replacement) {
      if (!context.drafts?.autoAuth) return toolResult('unavailable', 'automation-confirmation-unavailable');
      if (replacement.cwd) {
        const workspace = await resolveWorkingDirectory(replacement.cwd);
        if (!workspace.ok) return toolResult('unavailable', 'agent-cwd-unavailable', { operationId, reason: workspace.reason });
      }
      if (!replacement.pendingRecurring && !replacement.nextFireAt) return toolResult('validation-failed', 'no-remaining-fires', { operationId });
    }
    const result = await mutateAutomationTask({ store: context.store!, scheduler, chatId: context.chatId }, {
      actor: 'model', id: current.item.id, revision: params.revision as string | undefined,
      createdBy: context.actorId, registration, drafts: context.drafts!, cardReply: context.cardReply,
      ...(replacement ? { operation: 'replace' as const, replacement }
        : { operation: operation === 'automation.delete' ? 'delete' as const : operation === 'automation.resume' ? 'resume' as const : 'pause' as const }),
    });
    if (!result.ok) return 'category' in result
      ? toolResult(result.category, result.code) : fail(result.code);
    return getAutomationOperation(operationId, context);
  } catch { return unknownAutomationOperation(operationId, 'persistence-or-delivery-unknown'); }
}
