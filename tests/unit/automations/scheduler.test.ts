import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CATCH_UP_WINDOW_MS,
  formatFireKey,
  type Schedule,
} from '../../../src/automations/schedule';
import {
  STATUS_PUSH_DEBOUNCE_MS,
  STATUS_PUSH_MAX_NEXT_FIRES,
} from '../../../src/automations/status-push';
import { BoardActionAuth } from '../../../src/automations/board-auth';
import { automationBoardCard } from '../../../src/automations/board-card';
import { simplifiedBoardRender } from '../../../src/automations/status-block';
import {
  createAutomationScheduler,
  type FireSend,
  type MissedNotify,
} from '../../../src/automations/scheduler';
import {
  AUTOMATIONS_DRAFT_TTL_MS,
  AUTOMATIONS_MISSED_TTL_MS,
  AUTOMATIONS_STARTED_KEY_WINDOW_MS,
  AutomationsStore,
  type CreateAutomationInput,
} from '../../../src/automations/store';
import { log } from '../../../src/core/logger';
import * as atomicWrite from '../../../src/platform/atomic-write';
import { axiosLike, sdkShapedSendError } from '../../helpers/sdk-feishu-errors';

const HOUR = 60 * 60_000;
const t0 = Date.UTC(2026, 0, 2, 12, 0, 0);

const hourly: Schedule = {
  kind: 'interval',
  timezone: 'UTC',
  everyMs: HOUR,
  startAt: t0,
  endAt: t0 + 365 * 24 * HOUR,
};

const dirs: string[] = [];
const schedulers: Array<{ stop(): void }> = [];

afterEach(async () => {
  for (const scheduler of schedulers.splice(0).reverse()) scheduler.stop();
  await Promise.all(dirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
  ));
});

class ManualClock {
  nowMs: number;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  constructor(nowMs: number) {
    this.nowMs = nowMs;
  }

  now = (): number => this.nowMs;

  setTimeout = (fn: () => void, delayMs: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.nowMs + Math.max(0, delayMs), fn });
    return id;
  };

  clearTimeout = (id: unknown): void => {
    if (typeof id === 'number') this.timers.delete(id);
  };

  pendingCount(): number {
    return this.timers.size;
  };

  /** Wall-clock jump. Pending timers stay on their original deadlines. */
  jump(ms: number): void {
    this.nowMs += ms;
  }

  async advanceTo(target: number, idle: () => Promise<void>): Promise<void> {
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      const first = due[0];
      if (!first) {
        this.nowMs = Math.max(this.nowMs, target);
        return;
      }
      this.nowMs = Math.max(this.nowMs, first[1].at);
      this.timers.delete(first[0]);
      first[1].fn();
      await idle();
    }
  }
}

async function harness(nowMs: number, opts?: {
  isLinkUp?: () => boolean;
  send?: (fire: FireSend) => void | Promise<void>;
  agentTasks?: () => boolean;
  enabled?: () => boolean;
  setTimeout?: (fn: () => void, delayMs: number) => unknown;
  onChanged?: () => void | Promise<void>;
  onExpireDrafts?: () => void | Promise<void>;
  statusPush?: {
    endpoint?: string;
    secret?: string;
    profile: string;
    fetch?: typeof fetch;
  };
}) {
  const dir = await mkdtemp(join(tmpdir(), 'automations-scheduler-'));
  dirs.push(dir);
  const clock = new ManualClock(nowMs);
  const store = new AutomationsStore({
    path: join(dir, 'automations.json'),
    logPath: join(dir, 'automations.log'),
    statusPath: join(dir, 'automations-status.json'),
    now: clock.now,
  });
  await store.load();
  const fires: FireSend[] = [];
  const notices: MissedNotify[] = [];
  const scheduler = createAutomationScheduler({
    store,
    sender: {
      send: async (fire) => {
        fires.push(fire);
        await opts?.send?.(fire);
      },
    },
    notifier: { notify: async (notice) => { notices.push(notice); } },
    now: clock.now,
    setTimeout: opts?.setTimeout ?? clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    botDisplayName: () => 'Grok Bot',
    ...(opts?.isLinkUp ? { isLinkUp: opts.isLinkUp } : {}),
    ...(opts?.agentTasks ? { agentTasks: opts.agentTasks } : {}),
    ...(opts?.enabled ? { enabled: opts.enabled } : {}),
    ...(opts?.onChanged ? { onChanged: opts.onChanged } : {}),
    ...(opts?.onExpireDrafts ? { onExpireDrafts: opts.onExpireDrafts } : {}),
    ...(opts?.statusPush ? { statusPush: opts.statusPush } : {}),
  });
  schedulers.push(scheduler);
  return {
    dir,
    clock,
    store,
    fires,
    notices,
    scheduler,
    statusPath: join(dir, 'automations-status.json'),
    logPath: join(dir, 'automations.log'),
  };
}

async function reopen(dir: string, nowMs: number) {
  const clock = new ManualClock(nowMs);
  const store = new AutomationsStore({
    path: join(dir, 'automations.json'),
    logPath: join(dir, 'automations.log'),
    statusPath: join(dir, 'automations-status.json'),
    now: clock.now,
  });
  await store.load();
  const fires: FireSend[] = [];
  const notices: MissedNotify[] = [];
  const scheduler = createAutomationScheduler({
    store,
    sender: { send: async (fire) => { fires.push(fire); } },
    notifier: { notify: async (notice) => { notices.push(notice); } },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    botDisplayName: () => 'Grok Bot',
  });
  schedulers.push(scheduler);
  return {
    dir,
    clock,
    store,
    fires,
    notices,
    scheduler,
    statusPath: join(dir, 'automations-status.json'),
    logPath: join(dir, 'automations.log'),
  };
}

function reminderInput(overrides: Partial<CreateAutomationInput> = {}): CreateAutomationInput {
  return {
    taskType: 'reminder',
    schedule: hourly,
    timezone: 'UTC',
    startAt: t0,
    endAt: t0 + 365 * 24 * HOUR,
    nextFireAt: t0,
    chatId: 'oc_group',
    createdBy: 'ou_alice',
    name: 'hourly ping',
    taskText: 'ping',
    ...overrides,
  };
}

async function readStatus(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as {
    v: number;
    bot: string;
    updatedAt: number;
    items: Array<{
      id: number;
      paused: boolean;
      nextFireAt: number;
      lastFireAt: number;
      lastStatus: string;
      endAt: number;
      missed: number;
    }>;
  };
}

async function expectStatusMatchesStore(h: {
  store: AutomationsStore;
  statusPath: string;
}): Promise<void> {
  const status = await readStatus(h.statusPath);
  expect(status).toMatchObject({
    v: 1,
    bot: 'Grok Bot',
    items: h.store.list().map((item) => ({
      id: item.id,
      paused: item.paused,
      nextFireAt: item.nextFireAt,
      lastFireAt: item.lastFireAt,
      lastStatus: item.lastStatus,
      endAt: item.endAt,
      missed: item.missed,
    })),
  });
}

describe('automation scheduler', () => {
  it('expires posted drafts at TTL', async () => {
    const expired: string[] = [];
    const h = await harness(t0, {
      onExpireDrafts: async () => {
        for (const draft of h.store.listExpiredDrafts()) {
          expired.push(draft.draftId);
          await h.store.takeDraft(draft.draftId);
        }
      },
    });
    const draft = await h.store.saveDraft(reminderInput({
      nextFireAt: t0 + 10 * HOUR,
      name: 'draft',
    }));
    await h.store.bindDraftCard(draft.draftId, 'om_card', 'card_1');
    await h.scheduler.start();
    expect(expired).toEqual([]);
    h.clock.jump(AUTOMATIONS_DRAFT_TTL_MS + 1);
    await h.clock.advanceTo(h.clock.now(), () => h.scheduler.idle());
    expect(expired).toEqual([draft.draftId]);
    expect(h.store.listDrafts()).toEqual([]);
  });

  it('expires posted drafts even when automations are disabled', async () => {
    const expired: string[] = [];
    const h = await harness(t0, {
      enabled: () => false,
      onExpireDrafts: async () => {
        for (const draft of h.store.listExpiredDrafts()) {
          expired.push(draft.draftId);
          await h.store.takeDraft(draft.draftId);
        }
      },
    });
    const draft = await h.store.saveDraft(reminderInput({
      nextFireAt: t0 + 10 * HOUR,
      name: 'draft',
    }));
    await h.store.bindDraftCard(draft.draftId, 'om_card', 'card_1');
    await h.store.create(reminderInput({ nextFireAt: t0 }));
    await h.scheduler.start();
    await h.scheduler.idle();
    expect(h.fires).toEqual([]);
    expect(expired).toEqual([]);
    h.clock.jump(AUTOMATIONS_DRAFT_TTL_MS + 1);
    await h.clock.advanceTo(h.clock.now(), () => h.scheduler.idle());
    expect(expired).toEqual([draft.draftId]);
    expect(h.store.listDrafts()).toEqual([]);
    expect(h.fires).toEqual([]);
  });

  it('expires posted drafts that aged out while the process was down', async () => {
    const expired: string[] = [];
    const h = await harness(t0, {
      onExpireDrafts: async () => {
        for (const draft of h.store.listExpiredDrafts()) {
          expired.push(draft.draftId);
          await h.store.takeDraft(draft.draftId);
        }
      },
    });
    const draft = await h.store.saveDraft(reminderInput({
      nextFireAt: t0 + 10 * HOUR,
      name: 'draft',
    }));
    await h.store.bindDraftCard(draft.draftId, 'om_card', 'card_1');
    h.clock.jump(AUTOMATIONS_DRAFT_TTL_MS + 1);
    await h.scheduler.start();
    await h.scheduler.idle();
    expect(expired).toEqual([draft.draftId]);
  });

  it('deletes a recurring item with no remaining fires when the fake clock reaches endAt', async () => {
    const endAt = t0 + HOUR;
    const h = await harness(t0);
    await h.store.create(reminderInput({
      schedule: { ...hourly, startAt: t0, endAt },
      startAt: t0,
      endAt,
      nextFireAt: 0,
      name: 'done',
    }));
    await h.scheduler.start();
    await h.clock.advanceTo(endAt - 1, () => h.scheduler.idle());
    expect(h.store.list()).toHaveLength(1);
    await h.clock.advanceTo(endAt, () => h.scheduler.idle());
    expect(h.store.list()).toEqual([]);
    expect(await readStatus(h.statusPath)).toMatchObject({ items: [] });
  });

  it('does not label a 50ms-late timer fire as catch-up', async () => {
    const h = await harness(t0 + 50);
    await h.store.create(reminderInput({ nextFireAt: t0 }));
    await h.scheduler.start();
    await h.scheduler.idle();

    expect(h.fires).toEqual([
      expect.objectContaining({ fireAt: t0, catchUp: false }),
    ]);
    expect(await h.store.readLog()).toEqual([]);
    expect(await readStatus(h.statusPath)).toMatchObject({
      items: [expect.objectContaining({ lastFireAt: t0, lastStatus: 'ok', missed: 0 })],
    });
  });

  it('rearms a 40-day one-shot in segments of at most 60s without a 1ms spin', async () => {
    const fireAt = t0 + 40 * 24 * HOUR;
    const delays: number[] = [];
    const NODE_MAX = 2_147_483_647;
    const clockBox: { clock?: ManualClock } = {};
    const h = await harness(t0, {
      setTimeout: (fn, delayMs) => {
        delays.push(delayMs);
        return clockBox.clock!.setTimeout(fn, delayMs > NODE_MAX ? 1 : delayMs);
      },
    });
    clockBox.clock = h.clock;
    await h.store.create(reminderInput({
      schedule: { kind: 'one-shot', fireAt },
      startAt: t0,
      endAt: fireAt,
      nextFireAt: fireAt,
      name: '四十天后',
    }));
    await h.scheduler.start();
    await h.scheduler.idle();
    expect(delays[0]).toBeLessThanOrEqual(60_000);
    expect(delays[0]).toBeGreaterThan(1);
    await h.clock.advanceTo(t0 + 3 * 60_000, async () => {
      await h.scheduler.idle();
      if (delays.length > 12) throw new Error(`timer spin: ${delays.length} arms`);
    });
    expect(h.fires).toEqual([]);
    expect(delays.every((delay) => delay <= 60_000 && delay > 1)).toBe(true);
    expect(delays.length).toBeGreaterThanOrEqual(3);
    expect(delays.length).toBeLessThanOrEqual(8);
  });

  it('after a 2h wall-clock jump, the next segment delivers the due fire with a catch-up label', async () => {
    const fireAt = t0 + 10 * 60_000;
    const delays: number[] = [];
    const clockBox: { clock?: ManualClock } = {};
    const h = await harness(t0, {
      setTimeout: (fn, delayMs) => {
        delays.push(delayMs);
        return clockBox.clock!.setTimeout(fn, delayMs);
      },
    });
    clockBox.clock = h.clock;
    await h.store.create(reminderInput({
      schedule: { kind: 'one-shot', fireAt },
      startAt: t0,
      endAt: fireAt,
      nextFireAt: fireAt,
      name: '睡醒提醒',
    }));
    await h.scheduler.start();
    await h.scheduler.idle();
    expect(delays[0]).toBeLessThanOrEqual(60_000);
    expect(h.fires).toEqual([]);

    h.clock.jump(2 * HOUR);
    await h.clock.advanceTo(t0 + (delays[0] ?? 0), () => h.scheduler.idle());

    expect(h.fires).toEqual([
      expect.objectContaining({ fireAt, catchUp: true }),
    ]);
    expect(h.notices).toEqual([]);
    expect(await h.store.readLog()).toEqual([
      expect.objectContaining({
        id: 1,
        scheduledAt: fireAt,
        result: 'catch-up',
      }),
    ]);
    expect(await readStatus(h.statusPath)).toMatchObject({ items: [] });
  });

  it('does not label a 59s-late timer fire as catch-up', async () => {
    const h = await harness(t0 + 59_000);
    await h.store.create(reminderInput({
      schedule: { kind: 'one-shot', fireAt: t0 },
      startAt: t0 - 20 * 60_000,
      endAt: t0,
      nextFireAt: t0,
      name: '准点',
    }));
    await h.scheduler.start();
    await h.scheduler.idle();

    expect(h.fires).toEqual([
      expect.objectContaining({ fireAt: t0, catchUp: false }),
    ]);
    expect(await h.store.readLog()).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(await readStatus(h.statusPath)).toMatchObject({ items: [] });
  });

  it('labels a 61s-late missed fire as catch-up', async () => {
    const h = await harness(t0 + 61_000);
    await h.store.create(reminderInput({
      schedule: { kind: 'one-shot', fireAt: t0 },
      startAt: t0 - 20 * 60_000,
      endAt: t0,
      nextFireAt: t0,
      name: '迟到',
    }));
    await h.scheduler.start();
    await h.scheduler.idle();

    expect(h.fires).toEqual([
      expect.objectContaining({ fireAt: t0, catchUp: true }),
    ]);
    expect(h.notices).toEqual([]);
    expect(await h.store.readLog()).toEqual([
      expect.objectContaining({
        scheduledAt: t0,
        result: 'catch-up',
      }),
    ]);
    expect(await readStatus(h.statusPath)).toMatchObject({ items: [] });
  });

  it('pauses an existing agent task before markStarted when agentTasks is off', async () => {
    const h = await harness(t0, { agentTasks: () => false });
    await h.store.create(reminderInput({
      taskType: 'agent',
      cwd: h.dir,
      nextFireAt: t0,
      name: '汇总',
      taskText: '每天总结本群',
    }));
    await h.scheduler.start();
    await h.scheduler.idle();
    expect(h.fires).toEqual([]);
    expect(h.store.hasStarted(formatFireKey(1, t0))).toBe(false);
    expect(h.store.get(1)).toMatchObject({
      paused: true,
      nextFireAt: t0,
      lastFireAt: 0,
    });
    expect(h.store.get(1)?.lastStatus).not.toBe('running');
    expect(await readStatus(h.statusPath)).toMatchObject({
      items: [expect.objectContaining({ paused: true, lastFireAt: 0, lastStatus: 'ok' })],
    });
  });

  it('persists a weekend of 10-minute misses in batches', async () => {
    const ten = 10 * 60_000;
    const writes = { doc: 0, log: 0 };
    const actual = atomicWrite.writeFileAtomic;
    const spy = vi.spyOn(atomicWrite, 'writeFileAtomic')
      .mockImplementation(async (path, data, opts) => {
        if (String(path).endsWith('automations.json')) writes.doc += 1;
        if (String(path).endsWith('automations.log')) writes.log += 1;
        return actual(path, data, opts);
      });
    try {
      const h = await harness(t0 + 2 * 24 * HOUR + 1);
      await h.store.create(reminderInput({
        schedule: {
          kind: 'interval',
          timezone: 'UTC',
          everyMs: ten,
          startAt: t0,
          endAt: t0 + 365 * 24 * HOUR,
        },
        nextFireAt: t0,
      }));
      writes.doc = 0;
      writes.log = 0;
      await h.scheduler.start();
      await h.scheduler.idle();
      expect(h.store.get(1)?.missed).toBeGreaterThan(200);
      expect((await h.store.readLog()).filter((entry) => entry.result === 'missed').length)
        .toBe(h.store.get(1)?.missed);
      expect(writes.log).toBeGreaterThan(0);
      expect(writes.log).toBeLessThan(5);
      expect(writes.doc).toBeGreaterThan(0);
      expect(writes.doc).toBeLessThan(20);
    } finally {
      spy.mockRestore();
    }
  });

  it('calls the sender exactly once when the fake clock reaches the instant, and not before', async () => {
    const fireAt = t0 + 10 * 60_000;
    const h = await harness(t0);
    await h.store.create(reminderInput({
      schedule: { kind: 'one-shot', fireAt },
      startAt: t0,
      endAt: fireAt,
      nextFireAt: fireAt,
      name: '交周报',
    }));

    await h.scheduler.start();
    await h.clock.advanceTo(fireAt - 1, () => h.scheduler.idle());
    expect(h.fires).toEqual([]);

    await h.clock.advanceTo(fireAt, () => h.scheduler.idle());
    expect(h.fires).toEqual([
      expect.objectContaining({
        id: 1,
        fireAt,
        fireKey: formatFireKey(1, fireAt),
        catchUp: false,
      }),
    ]);
  });

  it('on restart after a 3-hour jump catches up the latest hour and traces the other two as missed', async () => {
    const stopped = await harness(t0);
    await stopped.store.create(reminderInput({ nextFireAt: t0 }));
    stopped.scheduler.stop();

    const restarted = await reopen(stopped.dir, t0 + 2 * HOUR + 1);
    await restarted.scheduler.start();
    await restarted.scheduler.idle();

    const latest = t0 + 2 * HOUR;
    expect(restarted.fires).toEqual([
      expect.objectContaining({
        fireAt: latest,
        fireKey: formatFireKey(1, latest),
        catchUp: true,
      }),
    ]);
    expect(restarted.store.get(1)?.missed).toBe(2);
    expect(restarted.notices).toEqual([
      expect.objectContaining({
        id: 1,
        missedFires: [t0, t0 + HOUR],
      }),
    ]);
    const logEntries = await restarted.store.readLog();
    expect(logEntries.filter((entry) => entry.result === 'missed')).toHaveLength(2);
    expect(logEntries.filter((entry) => entry.result === 'catch-up')).toEqual([
      expect.objectContaining({
        id: 1,
        scheduledAt: latest,
        triggerSource: 'startup',
        result: 'catch-up',
      }),
    ]);
  });

  it('abandons a 25 h old missed instant without sending, advances nextFireAt, and notifies + logs once', async () => {
    const fireAt = t0;
    const h = await harness(fireAt + CATCH_UP_WINDOW_MS + 60 * 60_000);
    await h.store.create(reminderInput({
      schedule: {
        kind: 'interval',
        timezone: 'UTC',
        everyMs: 48 * HOUR,
        startAt: fireAt,
        endAt: fireAt + 365 * 24 * HOUR,
      },
      nextFireAt: fireAt,
    }));

    await h.scheduler.start();
    await h.scheduler.idle();

    expect(h.fires).toEqual([]);
    expect(h.store.get(1)?.missed).toBe(1);
    expect(h.store.get(1)?.lastStatus).toBe('missed');
    expect(h.store.get(1)?.nextFireAt).toBe(fireAt + 48 * HOUR);
    expect(h.notices).toEqual([
      expect.objectContaining({ id: 1, missedFires: [fireAt] }),
    ]);
    await expect(h.store.readLog()).resolves.toEqual([
      expect.objectContaining({
        id: 1,
        scheduledAt: fireAt,
        triggerSource: 'startup',
        result: 'missed',
      }),
    ]);
  });

  it('sets a one-shot missed 25 h ago to nextFireAt 0, shows it missed, deletes it 24 h later, and keeps the log', async () => {
    const fireAt = t0;
    const missedAt = fireAt + CATCH_UP_WINDOW_MS + 1;
    const h = await harness(missedAt);
    await h.store.create(reminderInput({
      schedule: { kind: 'one-shot', fireAt },
      startAt: fireAt - 20 * 60_000,
      endAt: fireAt,
      nextFireAt: fireAt,
      name: 'one-shot',
    }));

    await h.scheduler.start();
    await h.scheduler.idle();

    expect(h.fires).toEqual([]);
    expect(h.store.get(1)?.nextFireAt).toBe(0);
    expect(h.store.get(1)?.lastStatus).toBe('missed');
    expect(h.store.get(1)?.missedInstants.map((entry) => entry.fireAt)).toEqual([fireAt]);
    const logAfterMiss = await h.store.readLog();
    expect(logAfterMiss).toEqual([
      expect.objectContaining({ result: 'missed', scheduledAt: fireAt }),
    ]);

    await h.clock.advanceTo(missedAt + CATCH_UP_WINDOW_MS, () => h.scheduler.idle());
    expect(h.store.get(1)).toBeDefined();

    const info = vi.spyOn(log, 'info');
    await h.clock.advanceTo(missedAt + CATCH_UP_WINDOW_MS + 1, () => h.scheduler.idle());
    expect(h.store.get(1)).toBeUndefined();
    expect(h.store.list()).toEqual([]);
    await expect(h.store.readLog()).resolves.toEqual(logAfterMiss);
    expect(info.mock.calls.some((call) => call[0] === 'auto' && call[1] === 'expired' && (call[2] as { id?: number })?.id === 1)).toBe(true);
    expect(JSON.stringify(info.mock.calls)).not.toContain('one-shot');
    info.mockRestore();
  });

  it('calls the sender once when restart, link-recovered and wake race for the same fire key', async () => {
    const fireAt = t0;
    const now = fireAt + 61_000;
    const orders: Array<Array<'start' | 'recovered' | 'wake'>> = [
      ['start', 'recovered', 'wake'],
      ['start', 'wake', 'recovered'],
      ['recovered', 'start', 'wake'],
      ['recovered', 'wake', 'start'],
      ['wake', 'start', 'recovered'],
      ['wake', 'recovered', 'start'],
    ];

    for (const order of orders) {
      const h = await harness(now);
      await h.store.create(reminderInput({
        schedule: { kind: 'one-shot', fireAt },
        startAt: fireAt - 20 * 60_000,
        endAt: fireAt,
        nextFireAt: fireAt,
      }));
      const fireKey = formatFireKey(1, fireAt);
      const info = vi.spyOn(log, 'info').mockImplementation(() => {});
      try {
        for (const step of order) {
          if (step === 'start') await h.scheduler.start();
          else if (step === 'recovered') await h.scheduler.onLinkRecovered();
          else await h.scheduler.wake(fireKey);
        }
        await h.scheduler.idle();
        expect(h.fires, order.join('>')).toEqual([
          expect.objectContaining({ fireKey, fireAt, catchUp: true }),
        ]);
        const silent = info.mock.calls.some((call) =>
          call[0] === 'auto' && call[1] === 'wake.already-started',
        );
        const wakeIndex = order.indexOf('wake');
        const startIndex = order.indexOf('start');
        const startedBeforeWake = startIndex !== -1 && startIndex < wakeIndex;
        expect(silent, order.join('>')).toBe(startedBeforeWake);
      } finally {
        info.mockRestore();
      }
    }

    const concurrent = await harness(now);
    await concurrent.store.create(reminderInput({
      schedule: { kind: 'one-shot', fireAt },
      startAt: fireAt - 20 * 60_000,
      endAt: fireAt,
      nextFireAt: fireAt,
    }));
    const fireKey = formatFireKey(1, fireAt);
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    try {
      await Promise.all([
        concurrent.scheduler.start(),
        concurrent.scheduler.onLinkRecovered(),
        concurrent.scheduler.wake(fireKey),
      ]);
      await concurrent.scheduler.idle();
      expect(concurrent.fires).toEqual([
        expect.objectContaining({ fireKey, fireAt, catchUp: true }),
      ]);
    } finally {
      info.mockRestore();
    }
  });

  it('keeps lastStatus running when link-recovered fires before start in the same process', async () => {
    const fireAt = t0;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness(fireAt, { send: () => hold });
    await h.store.create(reminderInput({
      taskType: 'agent',
      cwd: h.dir,
      schedule: hourly,
      startAt: t0,
      endAt: t0 + 365 * 24 * HOUR,
      nextFireAt: fireAt,
    }));

    await h.scheduler.onLinkRecovered();
    await h.scheduler.start();
    await h.scheduler.idle();
    expect(h.fires).toHaveLength(1);
    expect(h.store.get(1)?.lastStatus).toBe('running');
    expect(await readStatus(h.statusPath)).toMatchObject({
      items: [expect.objectContaining({ lastStatus: 'running', lastFireAt: fireAt })],
    });
    release();
  });

  it('marks a crash between started persist and settle as lastStatus failed, not ok', async () => {
    const fireAt = t0;
    const first = await harness(fireAt);
    await first.store.create(reminderInput({
      schedule: { kind: 'one-shot', fireAt },
      startAt: fireAt - 20 * 60_000,
      endAt: fireAt,
      nextFireAt: fireAt,
    }));
    await expect(first.store.markStarted(formatFireKey(1, fireAt))).resolves.toBe('started');
    expect(first.store.get(1)?.lastStatus).toBe('running');
    first.scheduler.stop();

    const restarted = await reopen(first.dir, fireAt + 60_000);
    await restarted.scheduler.start();
    await restarted.scheduler.idle();
    expect(restarted.fires).toEqual([]);
    expect(restarted.store.get(1)?.lastStatus).toBe('failed');
    expect(await readStatus(restarted.statusPath)).toMatchObject({
      items: [expect.objectContaining({ lastStatus: 'failed', lastFireAt: fireAt })],
    });
  });

  it('does not resend after a kill between started persist and the sender call', async () => {
    const fireAt = t0;
    const first = await harness(fireAt + 60_000);
    await first.store.create(reminderInput({
      schedule: { kind: 'one-shot', fireAt },
      startAt: fireAt - 20 * 60_000,
      endAt: fireAt,
      nextFireAt: fireAt,
    }));
    const fireKey = formatFireKey(1, fireAt);
    await expect(first.store.markStarted(fireKey)).resolves.toBe('started');
    first.scheduler.stop();

    const restarted = await reopen(first.dir, fireAt + 60_000);
    await restarted.scheduler.start();
    await restarted.scheduler.idle();
    await restarted.scheduler.wake(fireKey);
    await restarted.scheduler.idle();
    expect(restarted.fires).toEqual([]);
    expect(restarted.store.hasStarted(fireKey)).toBe(true);
  });

  it('rewrites status when missed instants age off the 24 h board window', async () => {
    const caughtUpAt = t0 + 2 * HOUR + 1;
    const h = await harness(caughtUpAt);
    await h.store.create(reminderInput());
    await h.scheduler.start();
    await h.scheduler.idle();
    expect(h.store.get(1)?.missedInstants.map((entry) => entry.fireAt)).toEqual([t0, t0 + HOUR]);
    await h.scheduler.pause(1);
    await h.scheduler.idle();
    const updatedAt = (await readStatus(h.statusPath)).updatedAt as number;

    await h.clock.advanceTo(caughtUpAt + CATCH_UP_WINDOW_MS, () => h.scheduler.idle());
    expect(h.store.get(1)?.missedInstants).toHaveLength(2);

    await h.clock.advanceTo(caughtUpAt + CATCH_UP_WINDOW_MS + 1, () => h.scheduler.idle());
    expect(h.store.get(1)?.missedInstants).toEqual([]);
    expect((await readStatus(h.statusPath)).updatedAt).toBeGreaterThan(updatedAt);
  });

  it('never catches up a paused item; resume recomputes nextFireAt from now', async () => {
    const h = await harness(t0 + 2 * HOUR + 1);
    const item = await h.store.create(reminderInput({ nextFireAt: t0, paused: true }));
    await h.scheduler.start();
    await h.scheduler.idle();
    expect(h.fires).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.store.get(item.id)?.nextFireAt).toBe(t0);
    expect(h.store.get(item.id)?.missed).toBe(0);

    await h.scheduler.resume(item.id);
    await h.scheduler.idle();
    expect(h.fires).toEqual([]);
    expect(h.store.get(item.id)?.paused).toBe(false);
    expect(h.store.get(item.id)?.nextFireAt).toBe(t0 + 3 * HOUR);
  });

  it('keeps the status file matched to the store after fire, catch-up, abandon, pause, and delete', async () => {
    const h = await harness(t0 - 1);
    const item = await h.store.create(reminderInput({ nextFireAt: t0, name: 'status' }));
    await h.scheduler.start();
    await h.clock.advanceTo(t0, () => h.scheduler.idle());
    await expectStatusMatchesStore(h);

    const catchUp = await harness(t0 + 2 * HOUR + 1);
    await catchUp.store.create(reminderInput({ nextFireAt: t0, name: 'catch' }));
    await catchUp.scheduler.start();
    await catchUp.scheduler.idle();
    await expectStatusMatchesStore(catchUp);

    const abandon = await harness(t0 + CATCH_UP_WINDOW_MS + HOUR);
    await abandon.store.create(reminderInput({
      schedule: {
        kind: 'interval',
        timezone: 'UTC',
        everyMs: 48 * HOUR,
        startAt: t0,
        endAt: t0 + 365 * 24 * HOUR,
      },
      nextFireAt: t0,
      name: 'abandon',
    }));
    await abandon.scheduler.start();
    await abandon.scheduler.idle();
    await expectStatusMatchesStore(abandon);

    await h.scheduler.pause(item.id);
    await h.scheduler.idle();
    await expectStatusMatchesStore(h);

    await h.scheduler.delete(item.id);
    await h.scheduler.idle();
    await expectStatusMatchesStore(h);
  });

  it('after catch-up keeps a fire due exactly now for the on-time path', async () => {
    const stopped = await harness(t0);
    await stopped.store.create(reminderInput({ nextFireAt: t0 }));
    stopped.scheduler.stop();

    const restarted = await reopen(stopped.dir, t0 + 2 * HOUR);
    await restarted.scheduler.start();
    await restarted.scheduler.idle();

    expect(restarted.fires.map((fire) => ({ fireAt: fire.fireAt, catchUp: fire.catchUp }))).toEqual([
      { fireAt: t0 + HOUR, catchUp: true },
      { fireAt: t0 + 2 * HOUR, catchUp: false },
    ]);
    expect(restarted.notices).toEqual([
      expect.objectContaining({ missedFires: [t0] }),
    ]);
  });

  it('writes status and does not start a catch-up fire while the link is down', async () => {
    const h = await harness(t0 + 2 * HOUR + 1, { isLinkUp: () => false });
    await h.store.create(reminderInput({ nextFireAt: t0 }));
    await h.scheduler.start();
    await h.scheduler.idle();

    expect(h.fires).toEqual([]);
    expect(h.store.get(1)?.nextFireAt).toBe(t0 + 2 * HOUR);
    expect(h.store.get(1)?.missed).toBe(2);
    expect(h.notices).toEqual([
      expect.objectContaining({ missedFires: [t0, t0 + HOUR] }),
    ]);
    await expectStatusMatchesStore(h);
  });

  it('skips the next agent fire while the previous run is unsettled and leaves a board and log trace', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness(t0, {
      send: () => hold,
    });
    await h.store.create(reminderInput({
      taskType: 'agent',
      cwd: h.dir,
      schedule: hourly,
      nextFireAt: t0,
      name: '汇总',
      taskText: '每天总结本群',
    }));
    await h.scheduler.start();
    await h.scheduler.idle();
    expect(h.fires).toHaveLength(1);
    expect(h.store.get(1)?.lastStatus).toBe('running');
    expect(h.store.get(1)?.lastFireAt).toBe(t0);

    await h.clock.advanceTo(t0 + HOUR, () => h.scheduler.idle());
    expect(h.fires).toHaveLength(1);
    expect(h.notices).toEqual([]);
    expect(h.store.get(1)).toMatchObject({
      lastStatus: 'running',
      lastFireAt: t0,
      nextFireAt: t0 + 2 * HOUR,
    });
    expect(await h.store.readLog()).toEqual([
      expect.objectContaining({
        id: 1,
        taskType: 'agent',
        scheduledAt: t0 + HOUR,
        result: 'skipped',
        skipReason: 'previous-run-unsettled',
      }),
    ]);
    const status = await readStatus(h.statusPath);
    expect(status.items).toEqual([
      expect.objectContaining({ id: 1, lastStatus: 'running', lastFireAt: t0 }),
    ]);
    const item = h.store.get(1);
    const rendered = simplifiedBoardRender(automationBoardCard({
      items: item ? [item] : [],
      auth: new BoardActionAuth({ secret: 'board-secret', now: () => h.clock.now() }),
    }));
    expect(rendered).toContain('已跳过 原定 2026-01-02 13:00');
    expect(rendered).not.toMatch(/\{/);
    expect(status.items[0]).toMatchObject({ lastStatus: 'running' });
    release();
  });

  it('skips overdue agent slots while the link is down instead of queueing them', async () => {
    let linkUp = true;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delays: number[] = [];
    const clockBox: { clock?: ManualClock } = {};
    const h = await harness(t0, {
      isLinkUp: () => linkUp,
      send: () => hold,
      setTimeout: (fn, delayMs) => {
        delays.push(delayMs);
        return clockBox.clock!.setTimeout(fn, delayMs);
      },
    });
    clockBox.clock = h.clock;
    await h.store.create(reminderInput({
      taskType: 'agent',
      cwd: h.dir,
      schedule: hourly,
      nextFireAt: t0,
      name: '汇总',
    }));
    await h.scheduler.start();
    await h.scheduler.idle();
    expect(h.fires).toHaveLength(1);
    linkUp = false;
    h.clock.jump(2 * HOUR);
    await h.clock.advanceTo(t0 + (delays.at(-1) ?? 0), () => h.scheduler.idle());

    expect(h.fires).toHaveLength(1);
    expect(h.notices).toEqual([]);
    expect(h.store.get(1)).toMatchObject({
      lastStatus: 'running',
      lastFireAt: t0,
      nextFireAt: t0 + 3 * HOUR,
    });
    expect(await h.store.readLog()).toEqual([
      expect.objectContaining({ scheduledAt: t0 + HOUR, result: 'skipped' }),
      expect.objectContaining({ scheduledAt: t0 + 2 * HOUR, result: 'skipped' }),
    ]);

    linkUp = true;
    await h.scheduler.onLinkRecovered();
    await h.scheduler.idle();
    expect(h.fires).toHaveLength(1);
    expect(h.store.get(1)?.lastStatus).toBe('running');
    release();
  });

  it('drops started fire keys older than 48h and keeps keys inside the window', async () => {
    const h = await harness(t0);
    await h.store.create(reminderInput({
      nextFireAt: t0 + 40 * 24 * HOUR,
      paused: true,
    }));
    const stale = formatFireKey(1, t0 - 48 * HOUR - 1);
    const kept = formatFireKey(1, t0 - 48 * HOUR);
    await h.store.markStarted(stale);
    await h.store.markStarted(kept);
    await h.scheduler.start();
    await h.scheduler.idle();

    expect(h.store.hasStarted(stale)).toBe(false);
    expect(h.store.hasStarted(kept)).toBe(true);
    expect(h.fires).toEqual([]);
    const onDisk = JSON.parse(await readFile(join(h.dir, 'automations.json'), 'utf8')) as { started: string[] };
    expect(onDisk.started).not.toContain(stale);
    expect(onDisk.started).toContain(kept);
  });

  it('starts overlapping fires without waiting for the previous sender to finish', async () => {
    const blocked: Array<() => void> = [];
    const h = await harness(t0, {
      send: () => new Promise<void>((resolve) => { blocked.push(resolve); }),
    });
    await h.store.create(reminderInput({
      schedule: { kind: 'one-shot', fireAt: t0 },
      startAt: t0 - 20 * 60_000,
      endAt: t0,
      nextFireAt: t0,
      name: 'one',
    }));
    await h.store.create(reminderInput({
      schedule: { kind: 'one-shot', fireAt: t0 },
      startAt: t0 - 20 * 60_000,
      endAt: t0,
      nextFireAt: t0,
      name: 'two',
    }));

    await h.scheduler.start();
    await h.scheduler.idle();
    expect(h.fires.map((fire) => fire.id).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(h.store.hasStarted(formatFireKey(1, t0))).toBe(true);
    expect(h.store.hasStarted(formatFireKey(2, t0))).toBe(true);
    expect(blocked).toHaveLength(2);
    for (const resolve of blocked) resolve();
    await h.scheduler.idle();
  });

  it('deletes a chat when fire send is rejected as not-in-chat and leaves other chats', async () => {
    const err = sdkShapedSendError('format_error', axiosLike('The bot can not be outside the group', {
      response: { status: 400, data: { code: 230002 } },
    }));
    const h = await harness(t0, {
      send: async (fire) => {
        if (fire.chatId === 'oc_gone') throw err;
      },
    });
    await h.store.create(reminderInput({
      chatId: 'oc_gone',
      nextFireAt: t0,
      name: 'leaving',
      taskText: 'secret fire body',
    }));
    await h.store.create(reminderInput({
      chatId: 'oc_keep',
      nextFireAt: t0 + HOUR,
      name: 'staying',
    }));

    const info = vi.spyOn(log, 'info');
    await h.scheduler.start();
    await h.scheduler.idle();
    await Promise.resolve();
    await h.scheduler.idle();

    expect(h.store.list().map((item) => item.chatId)).toEqual(['oc_keep']);
    expect(info.mock.calls.some((call) =>
      call[0] === 'auto' && call[1] === 'removed-from-chat' && (call[2] as { chatId?: string })?.chatId === 'oc_gone',
    )).toBe(true);
    expect(JSON.stringify(info.mock.calls)).not.toContain('secret fire body');
    info.mockRestore();
  });

  it('does not delete a chat when fire send is a gone-card 404', async () => {
    const err = sdkShapedSendError('unknown', axiosLike('not found', {
      response: { status: 404 },
    }));
    const h = await harness(t0, {
      send: async () => { throw err; },
    });
    await h.store.create(reminderInput({ nextFireAt: t0 }));
    await h.scheduler.start();
    await h.scheduler.idle();
    await Promise.resolve();
    await h.scheduler.idle();
    expect(h.store.list()).toHaveLength(1);
    expect(h.store.get(1)?.lastFireAt).toBe(t0);
  });

  it('fires the remaining due agent slot when the previous run settles during the first skip', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delays: number[] = [];
    const clockBox: { clock?: ManualClock } = {};
    const h = await harness(t0, {
      send: () => hold,
      setTimeout: (fn, delayMs) => {
        delays.push(delayMs);
        return clockBox.clock!.setTimeout(fn, delayMs);
      },
    });
    clockBox.clock = h.clock;
    await h.store.create(reminderInput({
      taskType: 'agent',
      cwd: h.dir,
      schedule: hourly,
      nextFireAt: t0,
      name: '汇总',
      taskText: '每天总结本群',
    }));
    await h.scheduler.start();
    await h.scheduler.idle();
    expect(h.fires).toEqual([expect.objectContaining({ fireAt: t0, catchUp: false })]);
    expect(h.store.get(1)?.lastStatus).toBe('running');

    let settled = false;
    const actual = atomicWrite.writeFileAtomic;
    const spy = vi.spyOn(atomicWrite, 'writeFileAtomic').mockImplementation(async (path, data, opts) => {
      const skipping = String(path).endsWith('automations.json')
        && String(data).includes('"reason": "previous-run-unsettled"');
      if (!settled && skipping) {
        settled = true;
        void h.store.settleFire(1, 'ok', formatFireKey(1, t0));
      }
      return actual(path, data, opts);
    });
    try {
      const armedAt = t0 + (delays.at(-1) ?? 0);
      h.clock.jump(2 * HOUR + 1);
      await h.clock.advanceTo(armedAt, () => h.scheduler.idle());
    } finally {
      spy.mockRestore();
      release();
    }

    expect(settled).toBe(true);
    expect(h.fires.map((fire) => ({ fireAt: fire.fireAt, catchUp: fire.catchUp }))).toEqual([
      { fireAt: t0, catchUp: false },
      { fireAt: t0 + 2 * HOUR, catchUp: false },
    ]);
    expect(h.notices).toEqual([]);
    expect(await h.store.readLog()).toEqual([
      expect.objectContaining({
        id: 1,
        taskType: 'agent',
        scheduledAt: t0 + HOUR,
        result: 'skipped',
        skipReason: 'previous-run-unsettled',
      }),
    ]);
    expect(h.store.get(1)).toMatchObject({
      lastStatus: 'running',
      lastFireAt: t0 + 2 * HOUR,
      nextFireAt: t0 + 3 * HOUR,
    });
    const status = await readStatus(h.statusPath);
    expect(status.items).toEqual([
      expect.objectContaining({
        id: 1,
        lastStatus: 'running',
        lastFireAt: t0 + 2 * HOUR,
        nextFireAt: t0 + 3 * HOUR,
      }),
    ]);
    const item = h.store.get(1);
    const rendered = simplifiedBoardRender(automationBoardCard({
      items: item ? [item] : [],
      auth: new BoardActionAuth({ secret: 'board-secret', now: () => h.clock.now() }),
    }));
    expect(rendered).toContain('已跳过 原定 2026-01-02 13:00');
    expect(rendered).not.toMatch(/\{/);
    expect(status.items[0]).toMatchObject({ lastStatus: 'running' });
    expect(h.clock.pendingCount()).toBe(1);
    expect(delays.at(-1)).toBe(60_000);
  });

  it('prunes started fire keys on the 60s wake after the last task is gone', async () => {
    const delays: number[] = [];
    const clockBox: { clock?: ManualClock } = {};
    const h = await harness(t0, {
      setTimeout: (fn, delayMs) => {
        delays.push(delayMs);
        return clockBox.clock!.setTimeout(fn, delayMs);
      },
    });
    clockBox.clock = h.clock;
    const staleAt = t0 - AUTOMATIONS_STARTED_KEY_WINDOW_MS + 30_000;
    const freshAt = t0 - AUTOMATIONS_STARTED_KEY_WINDOW_MS + 90_000;
    const stale = formatFireKey(1, staleAt);
    const fresh = formatFireKey(1, freshAt);
    await h.store.create(reminderInput({ nextFireAt: t0 + HOUR, paused: true }));
    await h.store.markStarted(stale);
    await h.store.markStarted(fresh);
    await h.store.delete(1);
    await h.scheduler.start();
    await h.scheduler.idle();

    expect(h.store.list()).toEqual([]);
    expect(h.fires).toEqual([]);
    expect(h.store.hasStarted(stale)).toBe(true);
    expect(h.store.hasStarted(fresh)).toBe(true);
    expect(h.clock.pendingCount()).toBe(1);
    expect(delays.at(-1)).toBeLessThanOrEqual(60_000);
    expect(delays.at(-1)).toBeGreaterThan(1);

    await h.clock.advanceTo(t0 + 60_000, () => h.scheduler.idle());
    expect(h.store.hasStarted(stale)).toBe(false);
    expect(h.store.hasStarted(fresh)).toBe(true);
    expect(h.clock.pendingCount()).toBe(1);
    expect(delays.at(-1)).toBeLessThanOrEqual(60_000);

    await h.clock.advanceTo(t0 + 120_000, () => h.scheduler.idle());
    expect(h.store.hasStarted(fresh)).toBe(false);
    expect(h.clock.pendingCount()).toBe(0);
    const onDisk = JSON.parse(await readFile(join(h.dir, 'automations.json'), 'utf8')) as { started: string[] };
    expect(onDisk.started).toEqual([]);
  });

  it('deletes aged skip rows and then does not rewrite status or the board', async () => {
    const delays: number[] = [];
    const clockBox: { clock?: ManualClock } = {};
    let boardUpdates = 0;
    const h = await harness(t0, {
      onChanged: () => { boardUpdates += 1; },
      setTimeout: (fn, delayMs) => {
        delays.push(delayMs);
        return clockBox.clock!.setTimeout(fn, delayMs);
      },
    });
    clockBox.clock = h.clock;
    const nextFireAt = t0 + AUTOMATIONS_MISSED_TTL_MS + 2 * HOUR;
    await h.store.create(reminderInput({ nextFireAt }));
    const skippedAt = t0 - HOUR;
    await h.store.recordSkippedFire(1, skippedAt, 'previous-run-unsettled', nextFireAt);
    await h.store.recordLog({
      id: 1,
      taskType: 'reminder',
      scheduledAt: skippedAt,
      decidedAt: t0,
      triggerSource: 'startup',
      result: 'skipped',
      skipReason: 'previous-run-unsettled',
    });
    h.clock.jump(AUTOMATIONS_MISSED_TTL_MS - 30_000);
    await h.scheduler.start();
    await h.scheduler.idle();
    expect(h.fires).toEqual([]);
    expect(h.notices).toEqual([]);
    const before = JSON.parse(await readFile(join(h.dir, 'automations.json'), 'utf8')) as {
      items: Array<{ skippedInstants: Array<{ fireAt: number }> }>;
    };
    expect(before.items[0]?.skippedInstants.map((entry) => entry.fireAt)).toEqual([skippedAt]);

    const writes = { doc: 0, status: 0 };
    const actual = atomicWrite.writeFileAtomic;
    const spy = vi.spyOn(atomicWrite, 'writeFileAtomic').mockImplementation(async (path, data, opts) => {
      if (String(path).endsWith('automations.json')) writes.doc += 1;
      if (String(path).endsWith('automations-status.json')) writes.status += 1;
      return actual(path, data, opts);
    });
    try {
      boardUpdates = 0;
      await h.clock.advanceTo(h.clock.now() + 60_000, () => h.scheduler.idle());
      const aged = JSON.parse(await readFile(join(h.dir, 'automations.json'), 'utf8')) as {
        items: Array<{ skippedInstants: unknown[] }>;
      };
      expect(aged.items[0]?.skippedInstants).toEqual([]);
      expect(h.store.get(1)?.skippedInstants).toEqual([]);
      expect(await h.store.readLog()).toEqual([
        expect.objectContaining({
          scheduledAt: skippedAt,
          result: 'skipped',
          skipReason: 'previous-run-unsettled',
        }),
      ]);
      const status = await readStatus(h.statusPath);
      expect(status.items).toEqual([
        expect.objectContaining({ id: 1, lastStatus: 'ok', nextFireAt }),
      ]);

      writes.doc = 0;
      writes.status = 0;
      boardUpdates = 0;
      const updatedAt = status.updatedAt;
      await h.clock.advanceTo(h.clock.now() + 3 * 60_000, () => h.scheduler.idle());
      expect(writes).toEqual({ doc: 0, status: 0 });
      expect(boardUpdates).toBe(0);
      expect((await readStatus(h.statusPath)).updatedAt).toBe(updatedAt);
      expect(h.fires).toEqual([]);
      expect(h.notices).toEqual([]);
      expect(delays.every((delay) => delay <= 60_000 && delay > 1)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('records a timer wake as timer when an unsettled agent skips and when a slot is past the grace', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = await harness(t0, { send: () => hold });
    await running.store.create(reminderInput({
      taskType: 'agent',
      cwd: running.dir,
      schedule: hourly,
      nextFireAt: t0,
    }));
    await running.scheduler.start();
    await running.scheduler.idle();
    await running.clock.advanceTo(t0 + HOUR, () => running.scheduler.idle());
    expect(await running.store.readLog()).toEqual([
      expect.objectContaining({
        scheduledAt: t0 + HOUR,
        result: 'skipped',
        triggerSource: 'timer',
      }),
    ]);
    release();

    const late = await harness(t0);
    await late.store.create(reminderInput({ nextFireAt: t0 + HOUR }));
    await late.scheduler.start();
    await late.scheduler.idle();
    late.clock.jump(HOUR + 61_000);
    await late.clock.advanceTo(late.clock.now(), () => late.scheduler.idle());
    expect(late.fires).toEqual([
      expect.objectContaining({ fireAt: t0 + HOUR, catchUp: true }),
    ]);
    expect(await late.store.readLog()).toEqual([
      expect.objectContaining({
        scheduledAt: t0 + HOUR,
        result: 'catch-up',
        triggerSource: 'timer',
      }),
    ]);
  });

  it('records a pre-start link recovery as startup and a later recovery as link-recovered', async () => {
    const fireAt = t0;
    const before = await harness(fireAt + 61_000);
    await before.store.create(reminderInput({
      schedule: { kind: 'one-shot', fireAt },
      startAt: fireAt - 20 * 60_000,
      endAt: fireAt,
      nextFireAt: fireAt,
    }));
    await before.scheduler.onLinkRecovered();
    await before.scheduler.start();
    await before.scheduler.idle();
    expect(before.fires).toEqual([expect.objectContaining({ fireAt, catchUp: true })]);
    expect(await before.store.readLog()).toEqual([
      expect.objectContaining({ result: 'catch-up', triggerSource: 'startup' }),
    ]);

    const after = await harness(t0);
    await after.store.create(reminderInput({ nextFireAt: t0 + HOUR }));
    await after.scheduler.start();
    await after.scheduler.idle();
    after.clock.jump(HOUR + 61_000);
    await after.scheduler.onLinkRecovered();
    await after.scheduler.idle();
    expect(await after.store.readLog()).toEqual([
      expect.objectContaining({
        scheduledAt: t0 + HOUR,
        result: 'catch-up',
        triggerSource: 'link-recovered',
      }),
    ]);
  });

  it('records the first connect after a down start as startup and a later outage as link-recovered', async () => {
    let linkUp = false;
    const now = t0 + 2 * HOUR + 61_000;
    const down = await harness(now, { isLinkUp: () => linkUp });
    await down.store.create(reminderInput({ nextFireAt: t0 }));
    await down.scheduler.start();
    await down.scheduler.idle();
    expect(down.fires).toEqual([]);
    expect(await down.store.readLog()).toEqual([
      expect.objectContaining({ scheduledAt: t0, result: 'missed', triggerSource: 'startup' }),
      expect.objectContaining({ scheduledAt: t0 + HOUR, result: 'missed', triggerSource: 'startup' }),
    ]);

    linkUp = true;
    await down.scheduler.onLinkRecovered();
    await down.scheduler.idle();
    expect(down.fires).toEqual([
      expect.objectContaining({ fireAt: t0 + 2 * HOUR, catchUp: true }),
    ]);
    expect(await down.store.readLog()).toEqual([
      expect.objectContaining({ scheduledAt: t0, result: 'missed', triggerSource: 'startup' }),
      expect.objectContaining({ scheduledAt: t0 + HOUR, result: 'missed', triggerSource: 'startup' }),
      expect.objectContaining({
        scheduledAt: t0 + 2 * HOUR,
        result: 'catch-up',
        triggerSource: 'startup',
      }),
    ]);

    down.clock.jump(HOUR + 61_000);
    linkUp = false;
    linkUp = true;
    await down.scheduler.onLinkRecovered();
    await down.scheduler.idle();
    expect(await down.store.readLog()).toEqual([
      expect.objectContaining({ scheduledAt: t0, result: 'missed', triggerSource: 'startup' }),
      expect.objectContaining({ scheduledAt: t0 + HOUR, result: 'missed', triggerSource: 'startup' }),
      expect.objectContaining({
        scheduledAt: t0 + 2 * HOUR,
        result: 'catch-up',
        triggerSource: 'startup',
      }),
      expect.objectContaining({
        scheduledAt: t0 + 3 * HOUR,
        result: 'catch-up',
        triggerSource: 'link-recovered',
      }),
    ]);
  });

  it('records a catch-up as startup when the link comes up during the final status write', async () => {
    let linkUp = false;
    let recovered = false;
    const schedulerBox: { scheduler?: { onLinkRecovered(): Promise<void> } } = {};
    let statusWrites = 0;
    const now = t0 + HOUR + 61_000;
    const h = await harness(now, {
      isLinkUp: () => linkUp,
      onChanged: () => {
        statusWrites += 1;
        if (statusWrites < 2 || recovered) return;
        linkUp = true;
        recovered = true;
        void schedulerBox.scheduler?.onLinkRecovered();
      },
    });
    schedulerBox.scheduler = h.scheduler;
    await h.store.create(reminderInput({ nextFireAt: t0 }));
    await h.scheduler.start();
    await h.scheduler.idle();
    expect(await h.store.readLog()).toEqual([
      expect.objectContaining({
        scheduledAt: t0,
        result: 'missed',
        triggerSource: 'startup',
      }),
      expect.objectContaining({
        scheduledAt: t0 + HOUR,
        result: 'catch-up',
        triggerSource: 'startup',
      }),
    ]);
  });

  it('records a confirm nudge as confirm', async () => {
    const h = await harness(t0);
    await h.store.create(reminderInput({ nextFireAt: t0 + HOUR }));
    await h.scheduler.start();
    await h.scheduler.idle();
    h.clock.jump(HOUR + 61_000);
    await h.scheduler.nudge();
    await h.scheduler.idle();
    expect(h.fires).toEqual([
      expect.objectContaining({ fireAt: t0 + HOUR, catchUp: true }),
    ]);
    expect(await h.store.readLog()).toEqual([
      expect.objectContaining({
        scheduledAt: t0 + HOUR,
        result: 'catch-up',
        triggerSource: 'confirm',
      }),
    ]);
  });

  it('records a wake catch-up as wake', async () => {
    const h = await harness(t0);
    await h.store.create(reminderInput({ nextFireAt: t0 + HOUR }));
    await h.scheduler.start();
    await h.scheduler.idle();
    h.clock.jump(HOUR + 61_000);
    await h.scheduler.wake(formatFireKey(1, t0 + HOUR));
    await h.scheduler.idle();
    expect(h.fires).toEqual([
      expect.objectContaining({ fireAt: t0 + HOUR, catchUp: true }),
    ]);
    expect(await h.store.readLog()).toEqual([
      expect.objectContaining({
        scheduledAt: t0 + HOUR,
        result: 'catch-up',
        triggerSource: 'wake',
      }),
    ]);
  });

  it('pushes lastFireAt equal to the planned instant when a fire starts, and does not push mid-window', async () => {
    const posts: string[] = [];
    const h = await harness(t0 - 1, {
      statusPush: {
        endpoint: 'https://status.test',
        secret: 'unit-status-secret',
        profile: 'test-profile',
        fetch: (async (_url: string | URL, init?: RequestInit) => {
          posts.push(String(init?.body ?? ''));
          return new Response(null, { status: 204 });
        }) as typeof fetch,
      },
    });
    await h.store.create(reminderInput({
      schedule: {
        kind: 'interval',
        timezone: 'UTC',
        everyMs: 10 * HOUR,
        startAt: t0,
        endAt: t0 + 365 * 24 * HOUR,
      },
      nextFireAt: t0,
    }));
    await h.scheduler.start();
    await h.clock.advanceTo(t0, () => h.scheduler.idle());
    await h.clock.advanceTo(t0 + STATUS_PUSH_DEBOUNCE_MS, () => h.scheduler.idle());
    expect(h.fires.map((fire) => fire.fireAt)).toEqual([t0]);
    const fired = JSON.parse(posts.at(-1)!) as {
      items: Array<{ lastFireAt: number; nextFires: number[] }>;
    };
    expect(fired.items[0]?.lastFireAt).toBe(t0);
    expect(fired.items[0]?.nextFires[0]).toBe(t0 + 10 * HOUR);
    const afterFire = posts.length;

    await h.clock.advanceTo(t0 + 5 * HOUR, () => h.scheduler.idle());
    expect(posts).toHaveLength(afterFire);
    expect(STATUS_PUSH_MAX_NEXT_FIRES).toBe(24);
  });

  it('pushes after a skipped slot advances state', async () => {
    const posts: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness(t0, {
      send: () => hold,
      statusPush: {
        endpoint: 'https://status.test',
        secret: 'unit-status-secret',
        profile: 'test-profile',
        fetch: (async (_url: string | URL, init?: RequestInit) => {
          posts.push(String(init?.body ?? ''));
          return new Response(null, { status: 204 });
        }) as typeof fetch,
      },
    });
    await h.store.create(reminderInput({
      taskType: 'agent',
      cwd: h.dir,
      nextFireAt: t0,
      name: '汇总',
      taskText: '每天总结本群',
    }));
    await h.scheduler.start();
    await h.scheduler.idle();
    await h.clock.advanceTo(t0 + STATUS_PUSH_DEBOUNCE_MS, () => h.scheduler.idle());
    posts.length = 0;
    await h.clock.advanceTo(t0 + HOUR, () => h.scheduler.idle());
    await h.clock.advanceTo(t0 + HOUR + STATUS_PUSH_DEBOUNCE_MS, () => h.scheduler.idle());
    expect(h.store.get(1)?.skippedInstants.map((entry) => entry.fireAt)).toEqual([t0 + HOUR]);
    const body = JSON.parse(posts.at(-1)!) as { items: Array<{ lastFireAt: number }> };
    expect(body.items[0]?.lastFireAt).toBe(t0);
    release();
  });

  it('pushes on startup and again on link recovery', async () => {
    const posts: string[] = [];
    const h = await harness(t0, {
      statusPush: {
        endpoint: 'https://status.test',
        secret: 'unit-status-secret',
        profile: 'test-profile',
        fetch: (async (_url: string | URL, init?: RequestInit) => {
          posts.push(String(init?.body ?? ''));
          return new Response(null, { status: 204 });
        }) as typeof fetch,
      },
    });
    await h.store.create(reminderInput({ nextFireAt: t0 + HOUR }));
    await h.scheduler.start();
    await h.clock.advanceTo(t0 + STATUS_PUSH_DEBOUNCE_MS, () => h.scheduler.idle());
    expect(posts).toHaveLength(1);
    const started = JSON.parse(posts[0]!) as { items: Array<{ lastFireAt: number; nextFires: number[] }> };
    expect(started.items[0]?.lastFireAt).toBe(0);
    expect(started.items[0]?.nextFires[0]).toBe(t0 + HOUR);

    posts.length = 0;
    await h.scheduler.onLinkRecovered();
    await h.clock.advanceTo(h.clock.now() + STATUS_PUSH_DEBOUNCE_MS, () => h.scheduler.idle());
    expect(posts).toHaveLength(1);
    const recovered = JSON.parse(posts[0]!) as { items: Array<{ nextFires: number[] }> };
    expect(recovered.items[0]?.nextFires[0]).toBe(t0 + HOUR);
  });

  it('pushes after a missed instant advances nextFireAt', async () => {
    const posts: string[] = [];
    const fireAt = t0;
    const now = fireAt + CATCH_UP_WINDOW_MS + HOUR;
    const h = await harness(now, {
      statusPush: {
        endpoint: 'https://status.test',
        secret: 'unit-status-secret',
        profile: 'test-profile',
        fetch: (async (_url: string | URL, init?: RequestInit) => {
          posts.push(String(init?.body ?? ''));
          return new Response(null, { status: 204 });
        }) as typeof fetch,
      },
    });
    await h.store.create(reminderInput({
      schedule: {
        kind: 'interval',
        timezone: 'UTC',
        everyMs: 48 * HOUR,
        startAt: fireAt,
        endAt: fireAt + 365 * 24 * HOUR,
      },
      nextFireAt: fireAt,
    }));
    await h.scheduler.start();
    await h.clock.advanceTo(now + STATUS_PUSH_DEBOUNCE_MS, () => h.scheduler.idle());
    expect(h.fires).toEqual([]);
    expect(h.store.get(1)?.missed).toBe(1);
    expect(h.store.get(1)?.nextFireAt).toBe(fireAt + 48 * HOUR);
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0]!) as { items: Array<{ lastFireAt: number; nextFires: number[] }> };
    expect(body.items[0]?.lastFireAt).toBe(0);
    expect(body.items[0]?.nextFires).toEqual([fireAt + 48 * HOUR]);
  });
});
