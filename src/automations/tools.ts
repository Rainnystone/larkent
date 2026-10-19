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
  timezone: string;
  agentTasks: boolean;
  now?: () => number;
}

const localTime = { type: 'object', required: ['hour', 'minute'], additionalProperties: false, properties: {
  hour: { type: 'integer', minimum: 0, maximum: 23 }, minute: { type: 'integer', minimum: 0, maximum: 59 },
} };
const scheduleSchema = { oneOf: [
  { type: 'object', required: ['kind', 'fireAt'], properties: { kind: { const: 'one-shot' }, fireAt: { type: 'number', description: 'UTC epoch milliseconds' } } },
  ...['daily', 'weekday', 'weekly', 'interval'].map(kind => ({
    type: 'object', required: ['kind', 'timezone', 'startAt', 'endAt', ...(kind === 'interval' ? ['every'] : ['times']), ...(kind === 'weekly' ? ['weekdays'] : [])],
    properties: { kind: { const: kind }, timezone: { type: 'string', description: 'IANA timezone' },
      startAt: { type: 'number', description: 'Inclusive UTC epoch milliseconds' }, endAt: { type: 'number', description: 'Exclusive UTC epoch milliseconds; required' },
      ...(kind === 'interval' ? { every: { type: 'object', required: ['unit', 'n'], properties: { unit: { enum: ['minutes', 'hours'] }, n: { type: 'integer', minimum: 1 } } },
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
      ...['create', 'replace', 'delete', 'pause', 'resume', 'operation.get'].map(name => [`automation.${name}`, { available: false, reason: 'not-implemented' }]),
    ]),
    defaults: { timezone: context.timezone }, agentTasks: context.agentTasks,
    limits: { reminderMinIntervalMs: REMINDER_MIN_INTERVAL_MS, agentMinIntervalMs: AGENT_MIN_INTERVAL_MS, maxHorizonMs: ONE_YEAR_MS },
    boundary: 'start-inclusive-end-exclusive', timestampUnit: 'UTC epoch milliseconds',
    categories: ['ok', 'validation-failed', 'needs-input', 'unavailable', 'unauthorized', 'execution-failed'],
  };
}

/** Read-only adapter to the existing schedule and store interfaces; no text parser. */
export function callAutomationTool(operation: string, params: Record<string, unknown>, context: AutomationToolContext): ToolResult {
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
  if (operation !== 'automation.preview') return toolResult('unavailable', 'not-implemented');
  if (Object.keys(params).some(key => !['taskType', 'schedule', 'timezone'].includes(key))) return toolResult('validation-failed', 'unknown-field');
  const fields = ['taskType', 'schedule'].filter(key => params[key] === undefined);
  if (fields.length) return toolResult('needs-input', 'missing-fields', { fields });
  if (params.taskType !== 'reminder' && params.taskType !== 'agent') return toolResult('validation-failed', 'invalid-task-type');
  if (params.taskType === 'agent' && !context.agentTasks) return toolResult('unavailable', 'agent-tasks-disabled');
  const input = record(params.schedule);
  if (!input) return toolResult('validation-failed', 'invalid-schedule');
  const kindFields: Record<string, string[]> = {
    'one-shot': ['kind', 'fireAt'], daily: ['kind', 'timezone', 'times', 'startAt', 'endAt'],
    weekday: ['kind', 'timezone', 'times', 'startAt', 'endAt'], weekly: ['kind', 'timezone', 'times', 'weekdays', 'startAt', 'endAt'],
    interval: ['kind', 'timezone', 'every', 'window', 'startAt', 'endAt'],
  };
  const allowed = typeof input.kind === 'string' ? kindFields[input.kind] : undefined;
  if (!allowed || Object.keys(input).some(key => !allowed.includes(key))) return toolResult('validation-failed', 'invalid-schedule');
  const required = allowed.filter(key => key !== 'window');
  const missing = required.filter(key => input[key] === undefined);
  if (missing.length) return toolResult('needs-input', missing.length === 1 && missing[0] === 'endAt' ? 'missing-end-at' : 'missing-fields', { fields: missing.map(key => `schedule.${key}`) });
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
