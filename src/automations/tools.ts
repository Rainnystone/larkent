import type { TurnJournal } from '../bot/turn-journal';
import { createReminderOperation, getReminderOperation } from './reminder-operation';
import type { DraftFlushContext } from './command';
import { formatZonedDateTime } from './confirm-card';
import { nextFireAfter, nextFires, parseSchedule, REMINDER_MIN_INTERVAL_MS, AGENT_MIN_INTERVAL_MS, ONE_YEAR_MS } from './schedule';
import type { AutomationsStore } from './store';
import { isValidTimeZone } from './zoned-time';
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
  timezone: string;
  agentTasks: boolean;
  now?: () => number;
}

const localTime = { type: 'object', required: ['hour', 'minute'], properties: {
  hour: { type: 'integer', minimum: 0, maximum: 23 }, minute: { type: 'integer', minimum: 0, maximum: 59 },
} };
const scheduleSchema = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['kind', 'fireAt'], properties: { kind: { const: 'one-shot' }, fireAt: { type: 'integer', description: 'UTC epoch milliseconds' } } },
  ...['daily', 'weekday', 'weekly', 'interval'].map(kind => ({
    type: 'object', additionalProperties: false, required: ['kind', 'timezone', 'startAt', 'endAt', ...(kind === 'interval' ? ['every'] : ['times']), ...(kind === 'weekly' ? ['weekdays'] : [])],
    properties: { kind: { const: kind }, timezone: { type: 'string', description: 'IANA timezone' },
      startAt: { type: 'integer', description: 'Inclusive UTC epoch milliseconds' }, endAt: { type: 'integer', description: 'Exclusive UTC epoch milliseconds; required' },
      ...(kind === 'interval' ? { every: { type: 'object', required: ['unit', 'n'], properties: { unit: { enum: ['minutes', 'hours'] }, n: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } } },
        window: { type: 'object', required: ['from', 'to'], properties: { from: localTime, to: localTime } } } : { times: { type: 'array', minItems: 1, items: localTime } }),
      ...(kind === 'weekly' ? { weekdays: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1, maximum: 7 }, description: 'Monday=1, Sunday=7' } } : {}),
    },
  })),
] };

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
  return {
    operations: Object.fromEntries([
      ['automation.schema', { available: !reason, ...(reason ? { reason } : {}), params: { type: 'object', additionalProperties: false } }],
      ['automation.list', { available: !reason, ...(reason ? { reason } : {}), params: { type: 'object', additionalProperties: false } }],
      ['automation.preview', { available: !reason, ...(reason ? { reason } : {}), params: AUTOMATION_PREVIEW_SCHEMA }],
      ['automation.create', { available: !reason, ...(reason ? { reason } : {}), params: { type: 'object', additionalProperties: false, required: ['taskType', 'name', 'taskText', 'schedule'], properties: { ...AUTOMATION_PREVIEW_SCHEMA.properties, taskType: { const: 'reminder' }, name: { type: 'string', minLength: 1 }, taskText: { type: 'string', minLength: 1 }, operationId: { type: 'string', description: 'Client assigns before submission; retain for queries and retries' } } } }],
      ['automation.operation.get', { available: !reason, ...(reason ? { reason } : {}), params: { type: 'object', additionalProperties: false, required: ['operationId'], properties: { operationId: { type: 'string' } } } }],
      ...['replace', 'delete', 'pause', 'resume'].map(name => [`automation.${name}`, { available: false, reason: 'not-implemented' }]),
    ]),
    defaults: { timezone: context.timezone }, agentTasks: context.agentTasks,
    limits: { reminderMinIntervalMs: REMINDER_MIN_INTERVAL_MS, agentMinIntervalMs: AGENT_MIN_INTERVAL_MS, maxHorizonMs: ONE_YEAR_MS },
    boundary: 'start-inclusive-end-exclusive', timestampUnit: 'UTC epoch milliseconds',
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
  if (operation === 'automation.create') return createReminderOperation(params, context, previewAutomation);
  if (operation === 'automation.operation.get') {
    if (Object.keys(params).some(key => key !== 'operationId')) return toolResult('validation-failed', 'unknown-field');
    return getReminderOperation(params.operationId, context);
  }
  if (operation !== 'automation.preview') return toolResult('unavailable', 'not-implemented');
  return previewAutomation(params, context);
}

function previewAutomation(params: Record<string, unknown>, context: AutomationToolContext): ToolResult {
  if (Object.keys(params).some(key => !['taskType', 'schedule', 'timezone'].includes(key))) return toolResult('validation-failed', 'unknown-field');
  const fields = ['taskType', 'schedule'].filter(key => params[key] === undefined);
  if (fields.length) return toolResult('needs-input', 'missing-fields', { fields });
  if (params.taskType !== 'reminder' && params.taskType !== 'agent') return toolResult('validation-failed', 'invalid-task-type');
  if (params.taskType === 'agent' && !context.agentTasks) return toolResult('unavailable', 'agent-tasks-disabled');
  const input = record(params.schedule);
  if (!input) return toolResult('validation-failed', 'invalid-schedule');
  if (input.kind === undefined) return toolResult('needs-input', 'missing-fields', { fields: ['schedule.kind'] });
  const shape = scheduleSchema.oneOf.find(shape => shape.properties.kind.const === input.kind);
  if (!shape || Object.keys(input).some(key => !Object.hasOwn(shape.properties, key))) return toolResult('validation-failed', 'invalid-schedule');
  const missing = missingRequiredFields(input, shape, 'schedule');
  if (missing.length) return toolResult('needs-input', missing.length === 1 && missing[0] === 'schedule.endAt' ? 'missing-end-at' : 'missing-fields', { fields: missing });
  // The text parser permits an omitted start. A supplied machine field must never silently default.
  const invalidInstants = ['startAt', 'endAt', 'fireAt'].filter(key => Object.hasOwn(input, key)
    && (typeof input[key] !== 'number' || !Number.isSafeInteger(input[key]) || !Number.isFinite(new Date(input[key] as number).getTime())));
  if (invalidInstants.length) return toolResult('validation-failed', 'invalid-schedule', { fields: invalidInstants.map(key => `schedule.${key}`) });
  const every = record(input.every);
  if (input.kind === 'interval' && every && typeof every.n === 'number' && !Number.isSafeInteger(every.n)) {
    return toolResult('validation-failed', 'invalid-schedule', { fields: ['schedule.every.n'] });
  }
  const now = (context.now ?? Date.now)();
  const parsed = parseSchedule(input, { taskType: params.taskType, now });
  if (!parsed.ok) return toolResult(parsed.reason === 'missing-end-at' ? 'needs-input' : 'validation-failed', parsed.reason,
    parsed.reason === 'missing-end-at' ? { fields: ['schedule.endAt'] } : undefined);
  const schedule = parsed.schedule;
  const timezone = schedule.kind === 'one-shot' ? params.timezone ?? context.timezone : schedule.timezone;
  if (typeof timezone !== 'string' || !isValidTimeZone(timezone)) return toolResult('validation-failed', 'invalid-timezone');
  const canonicalTimezone = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone;
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

function missingRequiredFields(value: unknown, schema: unknown, path: string): string[] {
  const shape = record(schema);
  if (!shape) return [];
  if (Array.isArray(value) && shape.items) return value.flatMap((item, i) => missingRequiredFields(item, shape.items, `${path}[${i}]`));
  const object = record(value);
  if (!object) return [];
  const missing = Array.isArray(shape.required) ? shape.required.filter((key): key is string => typeof key === 'string' && object[key] === undefined).map(key => `${path}.${key}`) : [];
  for (const [key, child] of Object.entries(record(shape.properties) ?? {})) {
    if (object[key] !== undefined) missing.push(...missingRequiredFields(object[key], child, `${path}.${key}`));
  }
  return missing;
}
