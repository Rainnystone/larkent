import { replyState } from '../bot/turn-journal';
import { resolveWorkingDirectory } from '../policy/workspace';
import { createHash } from 'node:crypto';
import { toolResult, type ToolResult } from '../bridge-tools/protocol';
import { flushDraftCardOnce } from './command';
import { AUTOMATION_OPERATION_TTL_MS, automationOperationScope, readAutomationOperationId } from './operation-id';
import { nextFireAfter } from './schedule';
import { normalizeAutomationSchedule } from './schedule-input';
import { DraftSupersessionConflict, type AutomationOperation, type AutomationsStore } from './store';
import { DRAFT_SETTLED_SUPERSEDED, scheduleDraftCardSettle } from './draft-card';
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

export async function createAutomationOperation(params: Record<string, unknown>, context: AutomationToolContext): Promise<ToolResult> {
  const operationId = params.operationId;
  const invalid = validateAutomationOperationId(operationId, context);
  if (invalid) return invalid;
  if (Object.keys(params).some(key => !['operationId', 'taskType', 'schedule', 'timezone', 'name', 'taskText', 'supersedesOperationId'].includes(key))) return toolResult('validation-failed', 'unknown-field');
  if (params.supersedesOperationId !== undefined) {
    const invalidTarget = validateAutomationOperationId(params.supersedesOperationId, context);
    if (invalidTarget) return invalidTarget;
  }
  if (!context.drafts?.autoAuth) return toolResult('unavailable', 'automation-confirmation-unavailable');
  return submit();

  async function submit(): Promise<ToolResult> {
    try {
      const now = (context.now ?? Date.now)();
      const issued = readAutomationOperationId(operationId)!;
      if (issued.issuedAt + AUTOMATION_OPERATION_TTL_MS <= now) return toolResult('validation-failed', 'operation-expired', { operationId });
      const previous = context.store!.getOperation(operationId as string);
      const at = previous?.createdAt ?? now;
      if (params.taskType !== 'reminder' && params.taskType !== 'agent') return toolResult('validation-failed', 'invalid-task-type');
      if (params.taskType === 'agent' && !context.agentTasks) return toolResult('unavailable', 'agent-tasks-disabled');
      const cwd = params.taskType === 'agent' ? context.cwd?.trim() : undefined;
      if (params.taskType === 'agent' && !cwd) return toolResult('unavailable', 'agent-needs-cwd');
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
      const fingerprint = createHash('sha256').update(JSON.stringify({ taskType: params.taskType, ...(cwd ? { cwd } : {}), name: params.name.trim(), taskText: params.taskText.trim(), timezone,
        ...(params.supersedesOperationId ? { supersedesOperationId: params.supersedesOperationId } : {}),
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
      if (cwd) {
        const workspace = await resolveWorkingDirectory(cwd);
        if (!workspace.ok) return toolResult('unavailable', 'agent-cwd-unavailable', { operationId, reason: workspace.reason });
      }
      const nextFireAt = schedule ? nextFireAfter(schedule, at) : 0;
      if (schedule && !nextFireAt) return toolResult('validation-failed', 'no-remaining-fires', { operationId });
      const superseded = typeof params.supersedesOperationId === 'string' ? context.store!.getOperation(params.supersedesOperationId) : undefined;
      const oldDraft = superseded ? context.store!.getOperationDraft(superseded.draftId) : undefined;
      const draft = await context.store!.saveDraft({
        taskType: params.taskType, ...(cwd ? { cwd } : {}), operationId: operationId as string, cardReply: context.cardReply, schedule: pending ?? schedule!, timezone,
        startAt,
        ...(pending ? { pendingRecurring: pending } : { endAt }),
        nextFireAt, name: params.name.trim(), taskText: params.taskText.trim(), chatId: context.chatId, createdBy: context.actorId,
      }, { operationId: operationId as string, profile: context.profile, chatId: context.chatId, fingerprint,
        ...(typeof params.supersedesOperationId === 'string' ? { supersedesOperationId: params.supersedesOperationId } : {}),
      });
      if (oldDraft) scheduleDraftCardSettle(context.drafts!.channel, oldDraft, DRAFT_SETTLED_SUPERSEDED);
      await flushDraftCardOnce(context.drafts!, draft.draftId, at);
      return automationOperationResult(context.store!.getOperation(operationId as string)!, context);
    } catch (error) {
      if (error instanceof DraftSupersessionConflict) return toolResult('validation-failed', 'draft-supersession-conflict', { operationId });
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
  const deliveryState = (entry: (typeof executions)[number]) => entry.cliAlreadySent ? 'sent' : replyState(entry) ?? 'pending';
  const delivered = executions.filter(entry => deliveryState(entry) === 'sent');
  const executionResult = (entry: (typeof executions)[number]): 'ok' | 'failed' | 'pending' => {
    if (entry.outcome) return entry.outcome.kind === 'completed' || entry.outcome.kind === 'partial' ? 'ok' : 'failed';
    if (entry.runId) return 'pending';
    const delivery = deliveryState(entry);
    return delivery === 'sent' ? 'ok' : delivery === 'rejected' ? 'failed' : 'pending';
  };
  const executionState = (entry: (typeof executions)[number]) => {
    if (entry.outcome) return entry.outcome.kind;
    if (entry.runId) return 'running';
    const result = executionResult(entry);
    return result === 'ok' ? 'completed' : result === 'failed' ? 'failed' : 'queued';
  };
  const last = executions.at(-1);
  const base = {
    operationId: current.operationId, draftId: current.draftId, received: true,
    ...(current.supersedesOperationId ? { supersedesOperationId: current.supersedesOperationId } : {}),
    ...(current.taskId ? { taskId: current.taskId } : {}),
    executionScope: 'task', dispatchedCount: current.dispatchedCountKnown === false ? null : current.dispatchedCount,
    ...(current.dispatchedCountKnown === false ? { dispatchedCountLowerBound: current.dispatchedCount } : {}), executedCount: executions.filter(entry => executionResult(entry) === 'ok').length,
    failedCount: executions.filter(entry => executionResult(entry) === 'failed').length, deliveredCount: delivered.length,
    executionHistoryComplete: current.dispatchedCountKnown !== false && executions.length === current.dispatchedCount,
    ...(last ? { lastExecution: executionResult(last), executionState: executionState(last), lastDelivery: deliveryState(last) } : {}),
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
  if (draft.delivery?.state === 'rejected') return toolResult('execution-failed', 'card-send-failed', { ...base, state: 'not-applied', applied: false });
  return unknownAutomationOperation(current.operationId, 'card-not-sent', base);
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
