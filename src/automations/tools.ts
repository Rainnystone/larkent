import { AUTOMATION_OPERATION_TTL_MS } from './operation-id';
import type { TurnJournal } from '../bot/turn-journal';
import { createReminderOperation, getReminderOperation } from './reminder-operation';
import type { DraftFlushContext } from './command';
import { formatZonedDateTime } from './confirm-card';
import { nextFireAfter, nextFires, REMINDER_MIN_INTERVAL_MS, AGENT_MIN_INTERVAL_MS, ONE_YEAR_MS } from './schedule';
import type { AutomationsStore, DraftCardReply } from './store';
import { normalizeAutomationSchedule, scheduleSchema } from './schedule-input';
import { record, toolResult, type ToolResult } from '../bridge-tools/protocol';

export interface AutomationToolContext {
  profile: string;
  chatId: string;
  actorId: string;
  runType: 'im' | 'automation';
  /** Bound at intake, never derived from model arguments. Rechecked on every call. */
  availability(): string | undefined;
  store?: AutomationsStore;
  drafts?: DraftFlushContext;
  journal?: TurnJournal;
  cardReply?: DraftCardReply;
  timezone: string;
  agentTasks: boolean;
  now?: () => number;
}

export const AUTOMATION_PREVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['taskType', 'schedule'], properties: {
    taskType: { enum: ['reminder', 'agent'] }, schedule: scheduleSchema,
    timezone: { type: 'string', description: 'Display timezone for one-shot; defaults to profile timezone' },
  },
};

export function automationToolAvailability(context: AutomationToolContext): string | undefined {
  return context.runType !== 'im' ? 'automation-management-unavailable-in-run'
    : context.availability() ?? (!context.store ? 'automation-store-unavailable' : undefined);
}

export function automationSchema(context: AutomationToolContext) {
  const reason = automationToolAvailability(context);
  const createReason = reason ?? (!context.drafts?.autoAuth ? 'automation-confirmation-unavailable' : undefined);
  return {
    operations: Object.fromEntries([
      ['automation.schema', { available: !reason, ...(reason ? { reason } : {}), params: { type: 'object', additionalProperties: false } }],
      ['automation.list', { available: !reason, ...(reason ? { reason } : {}), params: { type: 'object', additionalProperties: false } }],
      ['automation.preview', { available: !reason, ...(reason ? { reason } : {}), params: AUTOMATION_PREVIEW_SCHEMA }],
      ['automation.create', { available: !createReason, ...(createReason ? { reason: createReason } : {}), params: { type: 'object', additionalProperties: false, required: ['taskType', 'name', 'taskText', 'schedule'], properties: { ...AUTOMATION_PREVIEW_SCHEMA.properties, schedule: { oneOf: scheduleSchema.oneOf.map(shape => ({ ...shape, required: shape.required.filter(key => key !== 'endAt') })) }, taskType: { const: 'reminder' }, name: { type: 'string', minLength: 1 }, taskText: { type: 'string', minLength: 1 }, operationId: { type: 'string', description: 'Client assigns before submission; retain for queries and retries' } } } }],
      ['automation.operation.get', { available: !reason, ...(reason ? { reason } : {}), params: { type: 'object', additionalProperties: false, required: ['operationId'], properties: { operationId: { type: 'string' } } } }],
      ...['replace', 'delete', 'pause', 'resume'].map(name => [`automation.${name}`, { available: false, reason: 'not-implemented' }]),
    ]),
    defaults: { timezone: context.timezone }, agentTasks: context.agentTasks,
    limits: { reminderMinIntervalMs: REMINDER_MIN_INTERVAL_MS, agentMinIntervalMs: AGENT_MIN_INTERVAL_MS, maxHorizonMs: ONE_YEAR_MS },
    boundary: 'start-inclusive-end-exclusive', timestampUnit: 'UTC epoch milliseconds',
    confirmation: 'human-card-only',
    operationIds: { submissionTtlMs: AUTOMATION_OPERATION_TTL_MS, scope: 'profile-chat', retention: 'durable', recovery: 'query-original-id-before-retry' },
    categories: ['ok', 'validation-failed', 'needs-input', 'unavailable', 'unauthorized', 'execution-failed', 'waiting-confirmation', 'applied', 'unknown'],
  };
}

/** Adapter to the existing schedule and store interfaces; no text parser. */
export async function callAutomationTool(operation: string, params: Record<string, unknown>, context: AutomationToolContext): Promise<ToolResult> {
  const reason = automationToolAvailability(context);
  if (reason) return toolResult('unavailable', reason);
  if (operation === 'automation.schema') return Object.keys(params).length
    ? toolResult('validation-failed', 'unknown-field') : toolResult('ok', 'schema', automationSchema(context));
  if (operation === 'automation.list') {
    if (Object.keys(params).length) return toolResult('validation-failed', 'unknown-field');
    return toolResult('ok', 'tasks', { tasks: context.store!.list().filter(item => item.chatId === context.chatId).map(item => ({
      id: item.id, taskType: item.taskType, name: item.name, taskText: item.taskText, schedule: item.schedule,
      timezone: item.timezone, startAt: item.startAt, endAt: item.endAt, nextFireAt: item.nextFireAt,
      paused: item.paused, lastStatus: item.lastStatus,
    })) });
  }
  if (operation === 'automation.create') return createReminderOperation(params, context);
  if (operation === 'automation.operation.get') {
    if (Object.keys(params).some(key => key !== 'operationId')) return toolResult('validation-failed', 'unknown-field');
    return getReminderOperation(params.operationId, context);
  }
  if (operation !== 'automation.preview') return toolResult('unavailable', 'not-implemented');
  return previewAutomation(params, context);
}

function previewAutomation(params: Record<string, unknown>, context: AutomationToolContext): ToolResult {
  if (Object.keys(params).some(key => !['taskType', 'schedule', 'timezone'].includes(key))) return toolResult('validation-failed', 'unknown-field');
  const parsed = normalizeAutomationSchedule(params, context);
  if (!parsed.ok) return parsed.result;
  if ('pendingRecurring' in parsed) return toolResult('needs-input', 'missing-end-at', { fields: ['schedule.endAt'] });
  const { schedule, timezone: canonicalTimezone } = parsed;
  const now = (context.now ?? Date.now)();
  const startAt = schedule.kind === 'one-shot' ? schedule.fireAt : schedule.startAt;
  const endAt = schedule.kind === 'one-shot' ? schedule.fireAt : schedule.endAt;
  let totalCount = 0;
  let cursor = startAt - 1;
  for (;;) {
    const next = nextFireAfter(schedule, cursor);
    if (!next) break;
    totalCount++;
    cursor = next;
  }
  const fires = nextFires(schedule, Math.max(now - 1, startAt - 1), 10);
  return toolResult('ok', 'preview', {
    timezone: canonicalTimezone, schedule: schedule.kind === 'one-shot' ? schedule : { ...schedule, timezone: canonicalTimezone },
    startAt, endAt, endExclusive: schedule.kind !== 'one-shot', nextFires: fires, totalCount,
    local: { start: formatZonedDateTime(canonicalTimezone, startAt), end: formatZonedDateTime(canonicalTimezone, endAt), nextFires: fires.map(at => formatZonedDateTime(canonicalTimezone, at)) },
  });
}
