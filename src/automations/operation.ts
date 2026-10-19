import { createHash } from 'node:crypto';
import { toolResult, type ToolResult } from '../bridge-tools/protocol';
import { flushDraftCardOnce } from './command';
import { AUTOMATION_OPERATION_TTL_MS, automationOperationScope, readAutomationOperationId } from './operation-id';
import { nextFireAfter } from './schedule';
import { normalizeAutomationSchedule } from './schedule-input';
import type { AutomationOperation, AutomationsStore } from './store';
import type { AutomationToolContext } from './tools';

const writeTails = new WeakMap<AutomationsStore, Promise<unknown>>();
export async function serializeAutomationWrite(store: AutomationsStore, submit: () => Promise<ToolResult>): Promise<ToolResult> {
  const previous = writeTails.get(store) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(submit);
  writeTails.set(store, current);
  try { return await current; } finally { if (writeTails.get(store) === current) writeTails.delete(store); }
}

export async function getAutomationOperation(operationId: unknown, context: AutomationToolContext): Promise<ToolResult> {
  const invalid = validateAutomationOperationId(operationId, context);
  if (invalid) return invalid;
  try {
    const operation = context.store!.getOperation(operationId as string);
    if (!operation) return toolResult('execution-failed', 'operation-not-found', { operationId, state: 'not-applied', applied: false });
    if (operation.profile !== context.profile || operation.chatId !== context.chatId) return toolResult('unauthorized', 'operation-scope-mismatch');
    if (context.drafts) await flushDraftCardOnce(context.drafts, operation.draftId, (context.now ?? Date.now)());
    return automationOperationResult(operation, context);
  } catch {
    try { const operation = context.store!.getOperation(operationId as string); if (operation) return automationOperationResult(operation, context); } catch {}
    return unknownAutomationOperation(operationId as string, 'persistence-or-delivery-unknown');
  }
}

export async function createReminderOperation(params: Record<string, unknown>, context: AutomationToolContext): Promise<ToolResult> {
  const operationId = params.operationId;
  const invalid = validateAutomationOperationId(operationId, context);
  if (invalid) return invalid;
  if (Object.keys(params).some(key => !['operationId', 'taskType', 'schedule', 'timezone', 'name', 'taskText'].includes(key))) return toolResult('validation-failed', 'unknown-field');
  if (!context.drafts?.autoAuth) return toolResult('unavailable', 'automation-confirmation-unavailable');
  return submit();

  async function submit(): Promise<ToolResult> {
    try {
      const now = (context.now ?? Date.now)();
      const issued = readAutomationOperationId(operationId)!;
      if (issued.issuedAt + AUTOMATION_OPERATION_TTL_MS <= now) return toolResult('validation-failed', 'operation-expired', { operationId });
      const previous = context.store!.getOperation(operationId as string);
      const at = previous?.createdAt ?? now;
      if (params.taskType !== 'reminder') return toolResult(params.taskType === 'agent' ? 'unavailable' : 'validation-failed', params.taskType === 'agent' ? 'agent-creation-not-implemented' : 'invalid-task-type');
      const missing = ['name', 'taskText'].filter(key => params[key] === undefined);
      if (missing.length) return toolResult('needs-input', 'missing-fields', { fields: missing, operationId });
      if (typeof params.name !== 'string' || !params.name.trim() || typeof params.taskText !== 'string' || !params.taskText.trim()) return toolResult('validation-failed', 'invalid-task-content', { operationId });
      const normalized = normalizeAutomationSchedule(params, { ...context, now: () => at }, true);
      if (!normalized.ok) return { ...normalized.result, data: { ...(normalized.result.data as object), operationId } };
      const { timezone } = normalized;
      const pending = 'pendingRecurring' in normalized ? normalized.pendingRecurring : undefined;
      const schedule = 'schedule' in normalized ? normalized.schedule : undefined;
      const startAt = 'pendingRecurring' in normalized ? normalized.startAt : normalized.schedule.kind === 'one-shot' ? normalized.schedule.fireAt : normalized.schedule.startAt;
      const endAt = schedule ? schedule.kind === 'one-shot' ? schedule.fireAt : schedule.endAt : undefined;
      const fingerprint = createHash('sha256').update(JSON.stringify({ taskType: 'reminder', name: params.name.trim(), taskText: params.taskText.trim(), timezone,
        schedule: pending ? { ...pending, startAt, endAt: null } : schedule })).digest('hex');
      if (previous) {
        if (previous.fingerprint !== fingerprint) return toolResult('validation-failed', 'operation-conflict', { operationId });
        return getAutomationOperation(operationId, context);
      }
      const pendingOperation = context.store!.findReusableOperation(context.profile, context.chatId, fingerprint);
      if (pendingOperation) {
        await context.store!.aliasOperation(pendingOperation.operationId, operationId as string);
        const result = await getAutomationOperation(pendingOperation.operationId, context);
        return result.category === 'unknown' ? { ...result, code: 'prior-operation-unknown' } : result;
      }
      const nextFireAt = schedule ? nextFireAfter(schedule, at) : 0;
      if (schedule && !nextFireAt) return toolResult('validation-failed', 'no-remaining-fires', { operationId });
      const draft = await context.store!.saveDraft({
        taskType: 'reminder', operationId: operationId as string, cardReply: context.cardReply, schedule: pending ?? schedule!, timezone,
        startAt,
        ...(pending ? { pendingRecurring: pending } : { endAt }),
        nextFireAt, name: params.name.trim(), taskText: params.taskText.trim(), chatId: context.chatId, createdBy: context.actorId,
      }, { operationId: operationId as string, profile: context.profile, chatId: context.chatId, fingerprint });
      await flushDraftCardOnce(context.drafts!, draft.draftId, at);
      return automationOperationResult(context.store!.getOperation(operationId as string)!, context);
    } catch {
      try {
        const operation = context.store!.getOperation(operationId as string);
        if (operation) return automationOperationResult(operation, context);
      } catch {}
      return unknownAutomationOperation(operationId as string, 'persistence-or-delivery-unknown');
    }
  }
}

function automationOperationResult(operation: AutomationOperation, context: AutomationToolContext): ToolResult {
  const current = context.store!.getOperation(operation.operationId)!;
  const executions = context.journal?.list().filter(entry => current.taskId && entry.turnId.startsWith(`af:${current.taskId}@`)) ?? [];
  const delivered = executions.filter(entry => entry.reply?.state === 'sent');
  const last = executions.at(-1);
  const base = {
    operationId: current.operationId, draftId: current.draftId, received: true,
    ...(current.taskId ? { taskId: current.taskId } : {}),
    executionScope: 'task', dispatchedCount: current.dispatchedCount, executedCount: delivered.length,
    executionHistoryComplete: executions.length === current.dispatchedCount,
    ...(last ? { lastExecution: last.reply?.state === 'sent' ? 'ok' : last.reply?.state === 'rejected' ? 'failed' : 'pending' } : {}),
  };
  if (current.state === 'applied') return toolResult('applied', 'applied', { ...base, state: 'applied', applied: true });
  if (current.state === 'not-applied') return toolResult('execution-failed', current.code ?? 'not-applied', { ...base, state: 'not-applied', applied: false });
  const draft = context.store!.getOperationDraft(current.draftId);
  if (draft?.delivery?.state === 'sending') return unknownAutomationOperation(current.operationId, 'card-delivery-unknown', base);
  if (!draft || draft.createdAt + AUTOMATION_OPERATION_TTL_MS <= (context.now ?? Date.now)()) return toolResult('execution-failed', 'draft-expired', { ...base, state: 'not-applied', applied: false });
  const needsEnd = draft.op !== 'delete' && Boolean(draft.pendingRecurring);
  if (draft.cardMessageId) return toolResult(needsEnd ? 'needs-input' : 'waiting-confirmation', needsEnd ? 'missing-end-at' : 'waiting-confirmation', {
    ...base, state: needsEnd ? 'needs-input' : 'waiting-confirmation', applied: false, cardMessageId: draft.cardMessageId,
    ...(needsEnd ? { fields: ['schedule.endAt'] } : {}),
  });
  return toolResult('execution-failed', draft.delivery?.state === 'rejected' ? 'card-send-failed' : 'card-not-sent', { ...base, state: 'not-applied', applied: false });
}
export function validateAutomationOperationId(value: unknown, context: AutomationToolContext): ToolResult | undefined {
  const id = readAutomationOperationId(value);
  if (!id || id.issuedAt > (context.now ?? Date.now)() + 5 * 60_000) return toolResult('validation-failed', 'invalid-operation-id');
  if (id.scope !== automationOperationScope(context.profile, context.chatId)) return toolResult('unauthorized', 'operation-scope-mismatch');
  return undefined;
}
export function unknownAutomationOperation(operationId: string, code: string, data = {}): ToolResult {
  return toolResult('unknown', code, { ...data, operationId, state: 'unknown', applied: null });
}
