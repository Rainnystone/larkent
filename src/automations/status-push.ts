import { createHmac } from 'node:crypto';
import { nextFireAfter, readSchedule } from './schedule';
import type { AutomationItem } from './store';

export const STATUS_PUSH_MAX_NEXT_FIRES = 24;
export const STATUS_PUSH_WINDOW_MS = 24 * 60 * 60 * 1000;
export const STATUS_PUSH_DEBOUNCE_MS = 2_000;
export const STATUS_PUSH_ID_HEX_LEN = 32;
export const STATUS_PUSH_RETRY_MIN_MS = 1_000;
export const STATUS_PUSH_RETRY_MAX_MS = 60_000;
export const STATUS_PUSH_TIMESTAMP_HEADER = 'x-timestamp';
export const STATUS_PUSH_SIGNATURE_HEADER = 'x-signature';

export interface StatusPushItem {
  id: string;
  nextFires: number[];
  lastFireAt: number;
  paused: boolean;
  endAt: number;
}

export interface StatusPushPayload {
  v: 2;
  botKey: string;
  updatedAt: number;
  items: StatusPushItem[];
}

export function signStatusPush(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function opaqueBotKey(secret: string, profile: string): string {
  return hmacHex(secret, profile).slice(0, STATUS_PUSH_ID_HEX_LEN);
}

export function opaqueItemId(secret: string, profile: string, id: number): string {
  return hmacHex(secret, `${profile}:${id}`).slice(0, STATUS_PUSH_ID_HEX_LEN);
}

export function statusPushNextFires(
  item: Pick<AutomationItem, 'paused' | 'schedule' | 'nextFireAt'>,
  now: number,
): number[] {
  if (item.paused || item.nextFireAt <= 0) return [];
  const schedule = readSchedule(item.schedule);
  if (!schedule) return [];
  const windowEnd = now + STATUS_PUSH_WINDOW_MS;
  const fires: number[] = [];
  let cursor = now;
  for (;;) {
    const next = nextFireAfter(schedule, cursor);
    if (next === 0) break;
    if (next > windowEnd) {
      if (fires.length === 0) fires.push(next);
      break;
    }
    if (next > now) fires.push(next);
    if (fires.length >= STATUS_PUSH_MAX_NEXT_FIRES) break;
    cursor = next;
  }
  return fires;
}

export function buildStatusPushPayload(input: {
  secret: string;
  profile: string;
  updatedAt: number;
  now: number;
  items: AutomationItem[];
}): StatusPushPayload {
  return {
    v: 2,
    botKey: opaqueBotKey(input.secret, input.profile),
    updatedAt: input.updatedAt,
    items: input.items.map((entry) => ({
      id: opaqueItemId(input.secret, input.profile, entry.id),
      nextFires: statusPushNextFires(entry, input.now),
      lastFireAt: entry.lastFireAt,
      paused: entry.paused,
      endAt: entry.endAt,
    })),
  };
}

function hmacHex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}
