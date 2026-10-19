import { record, toolResult, type ToolCategory, type ToolResult } from '../bridge-tools/protocol';
import { parseSchedule, type PendingRecurring, type Schedule } from './schedule';
import type { AutomationToolContext } from './tools';
import { isValidTimeZone } from './zoned-time';

const localTime = { type: 'object', required: ['hour', 'minute'], properties: {
  hour: { type: 'integer', minimum: 0, maximum: 23 }, minute: { type: 'integer', minimum: 0, maximum: 59 },
} };
export const scheduleSchema = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['kind', 'fireAt'], properties: { kind: { const: 'one-shot' }, fireAt: { type: 'integer', description: 'UTC epoch milliseconds' } } },
  ...['daily', 'weekday', 'weekly', 'interval'].map(kind => ({
    type: 'object', additionalProperties: false, required: ['kind', 'timezone', 'startAt', 'endAt', ...(kind === 'interval' ? ['every'] : ['times']), ...(kind === 'weekly' ? ['weekdays'] : [])],
    properties: { kind: { const: kind }, timezone: { type: 'string', description: 'IANA timezone' },
      startAt: { type: 'integer', description: 'Inclusive UTC epoch milliseconds' }, endAt: { type: 'integer', description: 'Exclusive UTC epoch milliseconds' },
      ...(kind === 'interval' ? { every: { type: 'object', required: ['unit', 'n'], properties: { unit: { enum: ['minutes', 'hours'] }, n: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } } },
        window: { type: 'object', required: ['from', 'to'], properties: { from: localTime, to: localTime } } } : { times: { type: 'array', minItems: 1, items: localTime } }),
      ...(kind === 'weekly' ? { weekdays: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1, maximum: 7 }, description: 'Monday=1, Sunday=7' } } : {}),
    },
  })),
] };


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

type NormalizedSchedule = { ok: true; timezone: string } & (
  | { schedule: Schedule }
  | { pendingRecurring: PendingRecurring; startAt: number }
);
type ScheduleInputResult = NormalizedSchedule | { ok: false; result: ToolResult };

/** Shared machine validation and normalization. The pending branch never exposes a guessed end. */
export function normalizeAutomationSchedule(params: Record<string, unknown>, context: AutomationToolContext, allowMissingEnd = false): ScheduleInputResult {
  const reject = (category: ToolCategory, code: string, data?: unknown): ScheduleInputResult => ({ ok: false, result: toolResult(category, code, data) });
  const fields = ['taskType', 'schedule'].filter(key => params[key] === undefined);
  if (fields.length) return reject('needs-input', 'missing-fields', { fields });
  if (params.taskType !== 'reminder' && params.taskType !== 'agent') return reject('validation-failed', 'invalid-task-type');
  if (params.taskType === 'agent' && !context.agentTasks) return reject('unavailable', 'agent-tasks-disabled');
  const input = record(params.schedule);
  if (!input) return reject('validation-failed', 'invalid-schedule');
  if (input.kind === undefined) return reject('needs-input', 'missing-fields', { fields: ['schedule.kind'] });
  const shape = scheduleSchema.oneOf.find(shape => shape.properties.kind.const === input.kind);
  if (!shape || Object.keys(input).some(key => !Object.hasOwn(shape.properties, key))) return reject('validation-failed', 'invalid-schedule');
  const pending = allowMissingEnd && input.kind !== 'one-shot' && input.endAt === undefined;
  const missing = missingRequiredFields(input, shape, 'schedule').filter(field => !pending || field !== 'schedule.endAt');
  if (missing.length) return reject('needs-input', missing.length === 1 && missing[0] === 'schedule.endAt' ? 'missing-end-at' : 'missing-fields', { fields: missing });
  const invalidInstants = ['startAt', 'endAt', 'fireAt'].filter(key => Object.hasOwn(input, key)
    && (typeof input[key] !== 'number' || !Number.isSafeInteger(input[key]) || !Number.isFinite(new Date(input[key] as number).getTime())));
  if (invalidInstants.length) return reject('validation-failed', 'invalid-schedule', { fields: invalidInstants.map(key => `schedule.${key}`) });
  const every = record(input.every);
  if (input.kind === 'interval' && every && typeof every.n === 'number' && !Number.isSafeInteger(every.n)) return reject('validation-failed', 'invalid-schedule', { fields: ['schedule.every.n'] });
  const now = (context.now ?? Date.now)();
  // Validate an unfinished rule through the existing calculator, as the manual end-card path does.
  const parsed = parseSchedule(pending ? { ...input, endAt: (input.startAt as number) + 30 * 86400_000 } : input, { taskType: params.taskType, now });
  if (!parsed.ok) return reject(parsed.reason === 'missing-end-at' ? 'needs-input' : 'validation-failed', parsed.reason,
    parsed.reason === 'missing-end-at' ? { fields: ['schedule.endAt'] } : undefined);
  const timezone = parsed.schedule.kind === 'one-shot' ? params.timezone ?? context.timezone : parsed.schedule.timezone;
  if (typeof timezone !== 'string' || !isValidTimeZone(timezone)) return reject('validation-failed', 'invalid-timezone');
  const canonicalTimezone = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone;
  const schedule = parsed.schedule.kind === 'one-shot' ? parsed.schedule : { ...parsed.schedule, timezone: canonicalTimezone };
  if (!pending || schedule.kind === 'one-shot') return { ok: true, timezone: canonicalTimezone, schedule };
  const pendingRecurring: PendingRecurring = schedule.kind === 'interval'
    ? { kind: 'interval', timezone: canonicalTimezone, every: { unit: 'minutes', n: schedule.everyMs / 60_000 }, ...(schedule.window ? { window: schedule.window } : {}) }
    : { kind: schedule.kind, timezone: canonicalTimezone, times: [...schedule.times], ...(schedule.kind === 'weekly' ? { weekdays: [...schedule.weekdays] } : {}) };
  return { ok: true, timezone: canonicalTimezone, pendingRecurring, startAt: schedule.startAt };
}
