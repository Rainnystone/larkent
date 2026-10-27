import { manageAutomationOperation } from './manage-operation';
import { AUTOMATION_OPERATION_TTL_MS } from './operation-id';
import type { TurnJournal } from '../bot/turn-journal';
import { createAutomationOperation, getAutomationOperation, serializeAutomationWrite } from './operation';
import type { DraftConfirmationContext } from './draft-confirmation';
import { formatZonedDateTime } from './confirm-card';
import { fireTurnId } from './delivery';
import { policyGuardReasonLabel } from './policy-guard';
import { formatFireKey, nextFires, scheduleOccurrenceCount, REMINDER_MIN_INTERVAL_MS, AGENT_MIN_INTERVAL_MS, ONE_YEAR_MS } from './schedule';
import { automationTargetRevision } from './store';
import type { AutomationsStore, DraftCardReply } from './store';
import { normalizeAutomationSchedule, scheduleSchema } from './schedule-input';
import { toolResult, type ToolResult } from '../bridge-tools/protocol';

export interface AutomationToolContext {
  profile: string;
  chatId: string;
  actorId: string;
  runType: 'im' | 'automation';
  /** Bound at intake, never derived from model arguments. Rechecked on every call. */
  availability(): string | undefined;
  store?: AutomationsStore;
  drafts?: DraftConfirmationContext;
  journal?: TurnJournal;
  cardReply?: DraftCardReply;
  timezone: string;
  agentTasks: boolean;
  cwd?: string;
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
  const mutationReason = reason ?? (!context.drafts?.automationsScheduler ? 'automation-scheduler-unavailable' : undefined);
  const confirmedMutationReason = mutationReason ?? (!context.drafts?.autoAuth ? 'automation-confirmation-unavailable' : undefined);
  return {
    operations: Object.fromEntries([
      ['automation.schema', { available: !reason, ...(reason ? { reason } : {}), params: { type: 'object', additionalProperties: false } }],
      ['automation.list', { available: !reason, ...(reason ? { reason } : {}), params: { type: 'object', additionalProperties: false } }],
      ['automation.preview', { available: !reason, ...(reason ? { reason } : {}), params: AUTOMATION_PREVIEW_SCHEMA }],
      ['automation.create', { available: !createReason, ...(createReason ? { reason: createReason } : {}), params: { type: 'object', additionalProperties: false, required: ['taskType', 'name', 'taskText', 'schedule'], properties: { ...AUTOMATION_PREVIEW_SCHEMA.properties, schedule: { oneOf: scheduleSchema.oneOf.map(shape => ({ ...shape, required: shape.required.filter(key => key !== 'endAt') })) }, taskType: { enum: context.agentTasks ? ['reminder', 'agent'] : ['reminder'] }, name: { type: 'string', minLength: 1 }, taskText: { type: 'string', minLength: 1 }, supersedesOperationId: { type: 'string', description: 'Explicit operation ID of one pending create draft owned by this actor in this profile/chat; invalidates its old confirmation atomically. Omit for independent drafts.' }, operationId: { type: 'string', description: 'Client assigns before submission; retain for queries and retries' } } } }],
      ['automation.operation.get', { available: !reason, ...(reason ? { reason } : {}), params: { type: 'object', additionalProperties: false, required: ['operationId'], properties: { operationId: { type: 'string' } } } }],
      ...['pause', 'resume', 'delete'].map(name => { const unavailable = name === 'delete' ? confirmedMutationReason : mutationReason; return [`automation.${name}`, { available: !unavailable, ...(unavailable ? { reason: unavailable } : {}), params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'integer', minimum: 1 }, revision: { type: 'string', description: 'Expected management revision from automation.list; stale state is rejected' }, operationId: { type: 'string' } } } }]; }),
      ['automation.replace', { available: !confirmedMutationReason, ...(confirmedMutationReason ? { reason: confirmedMutationReason } : {}), params: { type: 'object', additionalProperties: false, required: ['id', 'taskType', 'name', 'taskText', 'schedule'], properties: { ...AUTOMATION_PREVIEW_SCHEMA.properties, schedule: { oneOf: scheduleSchema.oneOf.map(shape => ({ ...shape, required: shape.required.filter(key => key !== 'endAt') })) }, id: { type: 'integer', minimum: 1 }, revision: { type: 'string' }, name: { type: 'string', minLength: 1 }, taskText: { type: 'string', minLength: 1 }, operationId: { type: 'string' } } } }],
    ]),
    defaults: { timezone: context.timezone }, agentTasks: context.agentTasks,
    limits: { reminderMinIntervalMs: REMINDER_MIN_INTERVAL_MS, agentMinIntervalMs: AGENT_MIN_INTERVAL_MS, maxHorizonMs: ONE_YEAR_MS },
    boundary: 'start-inclusive-end-exclusive', timestampUnit: 'UTC epoch milliseconds',
    confirmation: { create: 'human-card-only', replace: 'human-card-only', delete: 'human-card-only', pause: 'immediate', resume: 'immediate' },
    operationIds: { submissionTtlMs: AUTOMATION_OPERATION_TTL_MS, scope: 'profile-chat', retention: 'durable', recovery: 'query-original-id-before-retry' },
    execution: { scope: 'task', dispatchedCount: 'integer-or-null', unknownCount: 'dispatchedCountLowerBound', history: 'retained-journal-evidence', executedCount: 'successful-runtime-outcome-or-reminder-delivery', failedCount: 'failed-or-interrupted', deliveredCount: 'sent-results-including-failure-notices', executionState: 'queued-running-or-runtime-outcome', lastDelivery: 'independent-outbox-state' },
    lastStatus: { never: 'not-yet-fired', running: 'in-flight', ok: 'last-run-succeeded', failed: 'last-run-failed', missed: 'last-fire-missed' },
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
    return toolResult('ok', 'tasks', { tasks: context.store!.listCommitted().filter(item => item.chatId === context.chatId).map(item => {
      const outcome = context.journal?.get(fireTurnId(formatFireKey(item.id, item.lastFireAt)))?.outcome;
      const code = outcome?.kind === 'interrupted' && outcome.reason.type === 'policy-guard'
        ? outcome.reason.code : undefined;
      return {
        id: item.id, revision: automationTargetRevision(item), taskType: item.taskType, name: item.name, taskText: item.taskText, schedule: item.schedule,
        timezone: item.timezone, startAt: item.startAt, endAt: item.endAt, nextFireAt: item.nextFireAt,
        paused: item.paused, lastStatus: item.lastStatus,
        ...(code ? { lastInterruption: { code, message: policyGuardReasonLabel(code) } } : {}),
      };
    }) });
  }
  if (operation === 'automation.pause' || operation === 'automation.resume' || operation === 'automation.delete' || operation === 'automation.replace') return serializeAutomationWrite(context.store!, () => manageAutomationOperation(operation, params, context));
  if (operation === 'automation.create') return serializeAutomationWrite(context.store!, () => createAutomationOperation(params, context));
  if (operation === 'automation.operation.get') {
    if (Object.keys(params).some(key => key !== 'operationId')) return toolResult('validation-failed', 'unknown-field');
    return getAutomationOperation(params.operationId, context);
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
  const counted = scheduleOccurrenceCount(schedule, now);
  const fires = nextFires(schedule, Math.max(now - 1, startAt - 1), 10);
  return toolResult('ok', 'preview', {
    timezone: canonicalTimezone, schedule: schedule.kind === 'one-shot' ? schedule : { ...schedule, timezone: canonicalTimezone },
    startAt, endAt, endExclusive: schedule.kind !== 'one-shot', nextFires: fires,
    occurrenceCount: counted.count, totalCount: counted.count, ...(counted.capped ? { occurrenceCountCapped: true } : {}),
    local: { start: formatZonedDateTime(canonicalTimezone, startAt), end: formatZonedDateTime(canonicalTimezone, endAt), nextFires: fires.map(at => formatZonedDateTime(canonicalTimezone, at)) },
  });
}
