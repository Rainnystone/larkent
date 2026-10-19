import { createHash } from 'node:crypto';
import { toolResult, type ToolResult } from '../bridge-tools/protocol';
import { AUTOMATION_OPERATION_TTL_MS, readAutomationOperationId } from './operation-id';
import { checkId, getReminderOperation, unknown } from './reminder-operation';
import type { AutomationToolContext } from './tools';

export async function manageAutomationOperation(operation: string, params: Record<string, unknown>, context: AutomationToolContext): Promise<ToolResult> {
  const invalid = checkId(params.operationId, context);
  if (invalid) return invalid;
  const operationId = params.operationId as string;
  if (Object.keys(params).some(key => !['id', 'operationId'].includes(key))) return toolResult('validation-failed', 'unknown-field');
  if (!Number.isSafeInteger(params.id) || (params.id as number) < 1) return toolResult('validation-failed', 'invalid-task-id');
  if (readAutomationOperationId(operationId)!.issuedAt + AUTOMATION_OPERATION_TTL_MS <= (context.now ?? Date.now)()) return toolResult('validation-failed', 'operation-expired', { operationId });
  const scheduler = context.drafts?.automationsScheduler;
  if (!scheduler) return toolResult('unavailable', 'automation-scheduler-unavailable');
  try {
    const fingerprint = createHash('sha256').update(JSON.stringify({ operation, id: params.id })).digest('hex');
    const previous = context.store!.getOperation(operationId);
    if (previous) return previous.fingerprint === fingerprint ? getReminderOperation(operationId, context) : toolResult('validation-failed', 'operation-conflict', { operationId });
    const item = context.store!.get(params.id as number);
    if (!item || item.chatId !== context.chatId) return toolResult('execution-failed', 'target-not-found', { operationId, state: 'not-applied', applied: false });
    const ok = await scheduler.pause(item.id, { operationId, fingerprint, profile: context.profile, chatId: context.chatId });
    if (!ok) return toolResult('execution-failed', 'target-not-found', { operationId, state: 'not-applied', applied: false });
    return getReminderOperation(operationId, context);
  } catch { return unknown(operationId, 'persistence-or-delivery-unknown'); }
}
