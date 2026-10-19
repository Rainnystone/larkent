import { createHash } from 'node:crypto';
import { toolResult, type ToolResult } from '../bridge-tools/protocol';
import { flushDraftCardOnce, type DraftFlushContext } from './command';
import { AUTOMATION_OPERATION_TTL_MS, automationOperationScope, readAutomationOperationId } from './operation-id';
import { nextFireAfter, parseSchedule, type PendingRecurring } from './schedule';
import type { AutomationOperation, AutomationsStore } from './store';
import type { AutomationToolContext } from './tools';

// The durable receipt is authoritative. This only serializes overlapping calls until it is written.
const claims = new WeakMap<AutomationsStore, Map<string, Promise<ToolResult>>>();
export interface ReminderOperationContext extends AutomationToolContext { drafts?: DraftFlushContext }

export async function getReminderOperation(operationId: unknown, context: ReminderOperationContext): Promise<ToolResult> {
  const invalid = checkId(operationId, context);
  if (invalid) return invalid;
  try {
    const operation = context.store!.getOperation(operationId as string);
    if (!operation) return toolResult('execution-failed', 'operation-not-found', { operationId, state: 'not-applied', applied: false });
    if (operation.profile !== context.profile || operation.chatId !== context.chatId) return toolResult('unauthorized', 'operation-scope-mismatch');
    if (context.drafts) await flushDraftCardOnce(context.drafts, operation.draftId, (context.now ?? Date.now)());
    return operationResult(operation, context);
  } catch {
    try { const operation = context.store!.getOperation(operationId as string); if (operation) return operationResult(operation, context); } catch {}
    return unknown(operationId as string, 'persistence-or-delivery-unknown');
  }
}

export async function createReminderOperation(params: Record<string, unknown>, context: ReminderOperationContext, validate: (params: Record<string, unknown>, context: AutomationToolContext) => ToolResult): Promise<ToolResult> {
  const operationId = params.operationId;
  const invalid = checkId(operationId, context);
  if (invalid) return invalid;
  if (Object.keys(params).some(key => !['operationId', 'taskType', 'schedule', 'timezone', 'name', 'taskText'].includes(key))) return toolResult('validation-failed', 'unknown-field');
  if (!context.drafts?.autoAuth) return toolResult('unavailable', 'automation-confirmation-unavailable');
  let map = claims.get(context.store!);
  if (!map) { map = new Map(); claims.set(context.store!, map); }
  const prior = map.get(operationId as string);
  if (prior) { await prior; return createReminderOperation(params, context, validate); }
  const promise = submit();
  map.set(operationId as string, promise);
  try { return await promise; } finally { if (map.get(operationId as string) === promise) map.delete(operationId as string); }

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
      const preview = validate({ taskType: params.taskType, schedule: params.schedule, ...(params.timezone !== undefined ? { timezone: params.timezone } : {}) }, { ...context, now: () => at });
      const needsEnd = preview.code === 'missing-end-at';
      if (preview.category !== 'ok' && !needsEnd) return { ...preview, data: { ...(preview.data as object), operationId } };
      const input = params.schedule as Record<string, unknown>;
      const parsed = parseSchedule(needsEnd ? { ...input, endAt: (input.startAt as number) + 30 * 86400_000 } : input, { taskType: 'reminder', now: at });
      if (!parsed.ok) return toolResult('validation-failed', parsed.reason, { operationId });
      const schedule = parsed.schedule;
      const timezone = needsEnd ? new Intl.DateTimeFormat('en', { timeZone: String(input.timezone) }).resolvedOptions().timeZone : (preview.data as { timezone: string }).timezone;
      const normalized = schedule.kind === 'one-shot' ? schedule : { ...schedule, timezone };
      const pending: PendingRecurring | undefined = needsEnd ? {
        kind: input.kind as PendingRecurring['kind'], timezone,
        ...(input.times ? { times: (normalized as PendingRecurring).times } : {}),
        ...(input.weekdays ? { weekdays: (normalized as PendingRecurring).weekdays } : {}),
        ...(input.every ? { every: input.every as PendingRecurring['every'] } : {}),
        ...(input.window ? { window: (normalized as PendingRecurring).window } : {}),
      } : undefined;
      const fingerprint = createHash('sha256').update(JSON.stringify({ taskType: 'reminder', name: params.name.trim(), taskText: params.taskText.trim(), timezone,
        schedule: needsEnd ? { ...normalized, endAt: null } : normalized })).digest('hex');
      if (previous) {
        if (previous.fingerprint !== fingerprint) return toolResult('validation-failed', 'operation-conflict', { operationId });
        return getReminderOperation(operationId, context);
      }
      const nextFireAt = needsEnd ? 0 : nextFireAfter(normalized, at);
      if (!needsEnd && !nextFireAt) return toolResult('validation-failed', 'no-remaining-fires', { operationId });
      const draft = await context.store!.saveDraft({
        taskType: 'reminder', operationId: operationId as string, schedule: pending ?? normalized, timezone,
        startAt: normalized.kind === 'one-shot' ? normalized.fireAt : normalized.startAt,
        ...(needsEnd ? { pendingRecurring: pending } : { endAt: normalized.kind === 'one-shot' ? normalized.fireAt : normalized.endAt }),
        nextFireAt, name: params.name.trim(), taskText: params.taskText.trim(), chatId: context.chatId, createdBy: context.actorId,
      }, { operationId: operationId as string, profile: context.profile, chatId: context.chatId, fingerprint });
      await flushDraftCardOnce(context.drafts!, draft.draftId, at);
      return operationResult(context.store!.getOperation(operationId as string)!, context);
    } catch {
      try {
        const operation = context.store!.getOperation(operationId as string);
        if (operation) return operationResult(operation, context);
      } catch {}
      return unknown(operationId as string, 'persistence-or-delivery-unknown');
    }
  }
}

function operationResult(operation: AutomationOperation, context: ReminderOperationContext): ToolResult {
  const current = context.store!.getOperation(operation.operationId)!;
  const executions = context.journal?.list().filter(entry => current.taskId && entry.turnId.startsWith(`af:${current.taskId}@`)) ?? [];
  const delivered = executions.filter(entry => entry.reply?.state === 'sent');
  const last = executions.at(-1);
  const base = { operationId: current.operationId, draftId: current.draftId, ...(current.taskId ? { taskId: current.taskId } : {}), dispatchedCount: current.executedCount, executedCount: delivered.length, executionHistoryComplete: executions.length === current.executedCount, ...(last ? { lastExecution: last.reply?.state === 'sent' ? 'ok' : last.reply?.state === 'rejected' ? 'failed' : 'pending' } : {}) };
  if (current.state === 'applied') return toolResult('applied', 'applied', { ...base, state: 'applied', applied: true });
  if (current.state === 'not-applied') return toolResult('execution-failed', current.code ?? 'not-applied', { ...base, state: 'not-applied', applied: false });
  const draft = context.store!.getDraft(current.draftId);
  if (!draft || draft.createdAt + AUTOMATION_OPERATION_TTL_MS <= (context.now ?? Date.now)()) return toolResult('execution-failed', 'draft-expired', { ...base, state: 'not-applied', applied: false });
  if (draft.cardMessageId) return toolResult(draft.op !== 'delete' && draft.pendingRecurring ? 'needs-input' : 'waiting-confirmation', draft.op !== 'delete' && draft.pendingRecurring ? 'missing-end-at' : 'waiting-confirmation', {
    ...base, state: draft.op !== 'delete' && draft.pendingRecurring ? 'needs-input' : 'waiting-confirmation', applied: false, cardMessageId: draft.cardMessageId,
    ...(draft.op !== 'delete' && draft.pendingRecurring ? { fields: ['schedule.endAt'] } : {}),
  });
  if (draft.delivery?.state === 'sending') return unknown(current.operationId, 'card-delivery-unknown', base);
  return toolResult('execution-failed', draft.delivery?.state === 'rejected' ? 'card-send-failed' : 'card-not-sent', { ...base, state: 'not-applied', applied: false });
}
function checkId(value: unknown, context: AutomationToolContext): ToolResult | undefined {
  const id = readAutomationOperationId(value);
  if (!id) return toolResult('validation-failed', 'invalid-operation-id');
  if (id.scope !== automationOperationScope(context.profile, context.chatId)) return toolResult('unauthorized', 'operation-scope-mismatch');
  return undefined;
}
function unknown(operationId: string, code: string, data = {}): ToolResult {
  return toolResult('unknown', code, { ...data, operationId, state: 'unknown', applied: null });
}
