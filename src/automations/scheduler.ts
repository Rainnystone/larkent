import { nextDraftConfirmationExpiry } from './draft-confirmation';
import { isNotInChat } from '../bot/feishu-error';
import { log } from '../core/logger';
import {
  CATCH_UP_WINDOW_MS,
  formatFireKey,
  isMissed,
  nextFireAfter,
  parseFireKey,
  planCatchUp,
  readSchedule,
  type Schedule,
} from './schedule';
import {
  AUTOMATIONS_MISSED_TTL_MS,
  type AutomationItem,
  type AutomationTaskType,
  type AutomationTriggerSource,
  type AutomationsStore,
} from './store';
import { createStatusPusher, type StatusPusher } from './status-pusher';
import { consumeWakeRequests, watchWakeDir, type WakeWatch } from './wake-file';

/**
 * Fires at most this late, with no earlier missed slot, are on-time.
 * This chooses the 补跑 label only. It does not change the miss rule.
 */
export const ON_TIME_GRACE_MS = 60_000;
/** Each arm sleeps at most this long, then recomputes due work from the wall clock. */
const SCHEDULER_SEGMENT_MS = 60_000;

export interface FireSend {
  id: number;
  fireAt: number;
  fireKey: string;
  catchUp: boolean;
  taskType: AutomationTaskType;
  name: string;
  taskText: string;
  timezone: string;
  chatId: string;
  createdBy: string;
  cwd?: string;
}

export interface MissedNotify {
  id: number;
  missedFires: number[];
  chatId: string;
  name: string;
  timezone: string;
}

export interface FireSender {
  send(fire: FireSend): void | Promise<void>;
}

export interface MissedNotifier {
  notify(notice: MissedNotify): void | Promise<void>;
}

export interface AutomationSchedulerDeps {
  store: AutomationsStore;
  sender: FireSender;
  notifier: MissedNotifier;
  botDisplayName: () => string;
  now?: () => number;
  setTimeout?: (fn: () => void, delayMs: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  isLinkUp?: () => boolean;
  enabled?: () => boolean;
  onChanged?: () => void | Promise<void>;
  onExpireDrafts?: () => void | Promise<void>;
  /** Profile `automations-wake/` directory. A5 local wake transport. */
  wakeDir?: string;
  agentTasks?: () => boolean;
  statusPush?: {
    endpoint?: string;
    secret?: string;
    profile: string;
    fetch?: typeof fetch;
  };
}

export interface AutomationScheduler {
  start(): Promise<void>;
  stop(): void;
  idle(): Promise<void>;
  onLinkRecovered(): Promise<void>;
  wake(fireKey: string): Promise<void>;
  notifyChanged(): Promise<void>;
  /** Re-arm after an in-process create/confirm so new nextFireAt / endAt take effect. */
  nudge(): Promise<void>;
  /** Serialize a task write with due fires, then refresh status and timers on success. */
  updateTasks<T extends { ok: boolean }>(write: (now: number) => Promise<T>): Promise<T>;
  pause(id: number): Promise<boolean>;
  removeFromChat(chatId: string): Promise<boolean>;
}

export function createAutomationScheduler(deps: AutomationSchedulerDeps): AutomationScheduler {
  return new Scheduler(deps);
}

class Scheduler implements AutomationScheduler {
  private readonly store: AutomationsStore;
  private readonly sender: FireSender;
  private readonly notifier: MissedNotifier;
  private readonly botDisplayName: () => string;
  private readonly now: () => number;
  private readonly setTimeout: (fn: () => void, delayMs: number) => unknown;
  private readonly clearTimeout: (id: unknown) => void;
  private readonly isLinkUp: () => boolean;
  private readonly enabled: () => boolean;
  private readonly onChanged?: () => void | Promise<void>;
  private readonly onExpireDrafts?: () => void | Promise<void>;
  private readonly wakeDir?: string;
  private readonly agentTasks: () => boolean;
  private readonly statusPusher?: StatusPusher;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  /** Crash leftovers are settled once, before the first fire in this process. */
  private orphansAbandoned = false;
  /** False until `start()` finishes its startup catch-up. Earlier link recovery folds into that pass. */
  private opened = false;
  /** True once a due pass has run with the link up. The first connect of a down start stays `startup`. */
  private linkSeenUp = false;
  private fireTimer: unknown;
  private wakeWatch?: WakeWatch;

  constructor(deps: AutomationSchedulerDeps) {
    this.store = deps.store;
    this.sender = deps.sender;
    this.notifier = deps.notifier;
    this.botDisplayName = deps.botDisplayName;
    this.now = deps.now ?? Date.now;
    this.setTimeout = deps.setTimeout ?? ((fn, delayMs) => setTimeout(fn, delayMs));
    this.clearTimeout = deps.clearTimeout ?? ((id) => clearTimeout(id as NodeJS.Timeout));
    this.isLinkUp = deps.isLinkUp ?? (() => true);
    this.enabled = deps.enabled ?? (() => true);
    this.onChanged = deps.onChanged;
    this.onExpireDrafts = deps.onExpireDrafts;
    this.wakeDir = deps.wakeDir;
    this.agentTasks = deps.agentTasks ?? (() => true);
    if (deps.statusPush) {
      this.statusPusher = createStatusPusher({
        ...deps.statusPush,
        store: this.store,
        now: this.now,
        setTimeout: this.setTimeout,
        clearTimeout: this.clearTimeout,
      });
    }
  }

  start(): Promise<void> {
    this.closed = false;
    return this.enqueue(async () => {
      await this.abandonOrphansOnce();
      await this.catchUp('startup');
      await this.handleDue('startup');
      await this.writeStatus();
      this.armWakeWatch();
      await this.drainWake();
      this.opened = true;
    });
  }

  stop(): void {
    this.closed = true;
    this.statusPusher?.stop();
    this.wakeWatch?.close();
    this.wakeWatch = undefined;
    this.clearTimers();
  }

  idle(): Promise<void> {
    return this.chain.then(() => this.statusPusher?.idle() ?? Promise.resolve());
  }

  onLinkRecovered(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed || !this.opened) return;
      const source: AutomationTriggerSource = this.linkSeenUp ? 'link-recovered' : 'startup';
      if (this.isLinkUp()) this.linkSeenUp = true;
      await this.abandonOrphansOnce();
      await this.catchUp(source);
      await this.handleDue(source);
      await this.writeStatus();
    });
  }

  notifyChanged(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) return;
      await this.writeStatus();
      this.armTimer();
    });
  }

  wake(fireKey: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.store.hasStarted(fireKey)) {
        log.info('auto', 'wake.already-started', { fireKey });
        return;
      }
      if (this.closed) return;
      const parsed = parseFireKey(fireKey);
      if (!parsed) return;
      await this.abandonOrphansOnce();
      await this.catchUp('wake');
      await this.handleDue('wake');
    });
  }

  nudge(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed || !this.enabled()) return;
      await this.abandonOrphansOnce();
      await this.handleDue('confirm');
    });
  }

  updateTasks<T extends { ok: boolean }>(write: (now: number) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const result = await write(this.now());
      if (result.ok) await this.writeStatus();
      this.armTimer();
      return result;
    });
  }

  async pause(id: number): Promise<boolean> {
    return (await this.updateTasks(async () => ({ ok: await this.store.pause(id) }))).ok;
  }


  removeFromChat(chatId: string): Promise<boolean> {
    return this.enqueue(() => this.dropChat(chatId));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => {},
      (error) => { log.fail('auto', error, { event: 'scheduler' }); },
    );
    return run;
  }

  /** Process boot only: a prior run that died after markStarted cannot still be live. */
  private async abandonOrphansOnce(): Promise<void> {
    if (this.orphansAbandoned) return;
    this.orphansAbandoned = true;
    await this.abandonOrphanRunning();
  }

  private async abandonOrphanRunning(): Promise<void> {
    let changed = false;
    for (const item of this.store.list()) {
      if (item.lastStatus !== 'running') continue;
      if (await this.store.settleFire(item.id, 'failed')) changed = true;
    }
    if (changed) await this.writeStatus();
  }

  private async catchUp(source: AutomationTriggerSource): Promise<void> {
    if (!this.enabled()) {
      await this.expireDraftCards();
      return;
    }
    if (this.isLinkUp()) this.linkSeenUp = true;
    for (const item of this.store.list()) {
      await this.reconcileStarted(item);
    }
    for (const item of this.store.list()) {
      await this.applyCatchUp(item, source);
    }
    await this.expireDue();
  }

  private async reconcileStarted(item: AutomationItem): Promise<void> {
    if (item.paused) return;
    if (!(item.nextFireAt > 0 && item.lastFireAt >= item.nextFireAt)) return;
    const schedule = readSchedule(item.schedule);
    if (!schedule) return;
    const next = nextFireAfter(schedule, item.lastFireAt);
    const ended = schedule.kind === 'one-shot' || next === 0;
    if (item.lastStatus === 'running') {
      await this.store.setNextFireAt(item.id, ended ? 0 : next);
      await this.writeStatus();
      return;
    }
    if (ended) {
      await this.store.setNextFireAt(item.id, 0, item.lastStatus);
      if (item.lastStatus !== 'failed') await this.store.delete(item.id);
    } else {
      await this.store.setNextFireAt(item.id, next, item.lastStatus);
    }
    await this.writeStatus();
  }

  private async applyCatchUp(item: AutomationItem, source: AutomationTriggerSource): Promise<void> {
    const state = await this.skipUnsettledAgentSlots(item, source);
    const live = state.item;
    if (!live || live.paused || state.unsettled) return;
    const schedule = readSchedule(live.schedule);
    if (!schedule) return;
    const now = this.now();
    if (
      live.nextFireAt > 0
      && live.nextFireAt <= now
      && now - live.nextFireAt <= ON_TIME_GRACE_MS
      && live.lastFireAt < live.nextFireAt
    ) {
      if (!this.isLinkUp()) return;
      await this.fireExact(live, live.nextFireAt, false, source, schedule);
      return;
    }
    if (!isMissed({
      id: live.id,
      paused: live.paused,
      nextFireAt: live.nextFireAt,
      lastFireAt: live.lastFireAt,
      schedule,
    }, now)) return;

    const plan = planCatchUp({
      id: live.id,
      paused: live.paused,
      nextFireAt: live.nextFireAt,
      lastFireAt: live.lastFireAt,
      schedule,
    }, now);

    const current = this.store.get(live.id);
    const already = new Set((current?.missedInstants ?? []).map((entry) => entry.fireAt));
    const newlyMissed = plan.missedFires.filter((fireAt) => !already.has(fireAt));
    if (newlyMissed.length > 0) {
      await this.store.recordMissedInstants(live.id, newlyMissed);
      await this.store.recordLogs(newlyMissed.map((fireAt) => ({
        id: live.id,
        taskType: live.taskType,
        scheduledAt: fireAt,
        decidedAt: now,
        triggerSource: source,
        result: 'missed' as const,
      })));
      for (const fireAt of newlyMissed) {
        log.info('auto', 'missed', { id: live.id, fireAt, triggerSource: source });
      }
    }
    if (newlyMissed.length > 0) {
      try {
        await this.notifier.notify({
          id: live.id,
          missedFires: newlyMissed,
          chatId: live.chatId,
          name: live.name,
          timezone: live.timezone,
        });
      } catch (error) {
        if (isNotInChat(error)) {
          await this.dropChat(live.chatId);
          return;
        }
        log.fail('auto', error, { event: 'missed' });
      }
    }

    if (plan.run !== undefined) {
      if (!this.isLinkUp()) {
        await this.store.setNextFireAt(live.id, plan.run);
        await this.writeStatus();
        return;
      }
      const onTime = plan.missedFires.length === 0 && now - plan.run <= ON_TIME_GRACE_MS;
      await this.fireExact(live, plan.run, !onTime, source, schedule);
      return;
    }

    await this.advanceAfterAbandon(live.id, schedule, now);
    await this.writeStatus();
  }

  private async advanceAfterAbandon(id: number, schedule: Schedule, now: number): Promise<void> {
    if (schedule.kind === 'one-shot') {
      await this.store.setNextFireAt(id, 0, 'missed');
      return;
    }
    const next = nextFireAfter(schedule, now);
    await this.store.setNextFireAt(id, next, 'missed');
    if (next === 0) await this.store.delete(id);
  }

  private async fireExact(
    item: AutomationItem,
    fireAt: number,
    catchUp: boolean,
    source: AutomationTriggerSource,
    schedule: Schedule,
  ): Promise<void> {
    if (item.taskType === 'agent' && !this.agentTasks()) {
      await this.store.pause(item.id);
      log.info('auto', 'paused', { id: item.id });
      await this.writeStatus();
      return;
    }
    const fireKey = formatFireKey(item.id, fireAt);
    const marked = await this.store.markStarted(fireKey);
    if (marked !== 'started') return;
    const now = this.now();
    const nextAfterFire = nextFireAfter(schedule, fireAt);
    const next = catchUp
      ? (nextAfterFire === now ? now : nextFireAfter(schedule, now))
      : nextAfterFire;
    const ended = schedule.kind === 'one-shot' || next === 0;
    switch (item.taskType) {
      case 'agent':
        // Stay `running` until the agent (or reap) settles ok/failed. Keep
        // one-shots on the board so a mid-run death cannot look like success.
        await this.store.setNextFireAt(item.id, ended ? 0 : next);
        break;
      case 'reminder':
        if (ended) {
          await this.store.setNextFireAt(item.id, 0, 'ok');
          await this.store.delete(item.id);
        } else {
          await this.store.setNextFireAt(item.id, next, 'ok');
        }
        break;
      default: {
        const _exhaustive: never = item.taskType;
        throw _exhaustive;
      }
    }
    if (catchUp) {
      await this.store.recordLog({
        id: item.id,
        taskType: item.taskType,
        scheduledAt: fireAt,
        decidedAt: now,
        triggerSource: source,
        result: 'catch-up',
      });
      log.info('auto', 'catch-up', { id: item.id, fireAt, triggerSource: source });
    } else {
      log.info('auto', 'fire', { id: item.id, fireAt });
    }
    await this.writeStatus();
    const payload: FireSend = {
      id: item.id,
      fireAt,
      fireKey,
      catchUp,
      taskType: item.taskType,
      name: item.name,
      taskText: item.taskText,
      timezone: item.timezone,
      chatId: item.chatId,
      createdBy: item.createdBy,
      ...(item.cwd ? { cwd: item.cwd } : {}),
    };
    void Promise.resolve(this.sender.send(payload)).then(
      () => {},
      (error) => {
        if (isNotInChat(error)) {
          void this.removeFromChat(item.chatId);
          return;
        }
        log.fail('auto', error, { event: catchUp ? 'catch-up' : 'fire' });
        if (item.taskType !== 'agent') return;
        void this.store.settleFire(item.id, 'failed', fireKey).then(
          (changed) => {
            if (changed) return this.writeStatus();
          },
          (settleError) => {
            log.fail('auto', settleError, { event: 'settle' });
          },
        );
      },
    );
  }

  /**
   * Skip due slots of an agent task whose previous run has not settled.
   * Re-reads after every skip. `unsettled` is true only while that run is
   * still in flight; a settle mid-skip leaves the latest item for the caller
   * to fire or catch up. Does not send, so it runs while the link is down.
   */
  private async skipUnsettledAgentSlots(
    item: AutomationItem,
    source: AutomationTriggerSource,
  ): Promise<{ item: AutomationItem | undefined; unsettled: boolean }> {
    let live = this.store.get(item.id);
    if (!live || live.paused || live.taskType !== 'agent' || live.lastStatus !== 'running') {
      return { item: live, unsettled: false };
    }
    const seen = new Set<number>();
    while (live.lastStatus === 'running' && live.nextFireAt > 0 && live.nextFireAt <= this.now()) {
      if (seen.has(live.nextFireAt)) break;
      seen.add(live.nextFireAt);
      const schedule = readSchedule(live.schedule);
      if (!schedule) break;
      const skipped = await this.skipUnsettledAgent(live, live.nextFireAt, source, schedule);
      const refreshed = this.store.get(item.id);
      if (!refreshed) return { item: undefined, unsettled: false };
      live = refreshed;
      if (!skipped) break;
    }
    return { item: live, unsettled: live.lastStatus === 'running' };
  }

  /**
   * An agent task with an unsettled run skips this slot: no second run, no
   * group post. The board and automations log keep the original time.
   */
  private async skipUnsettledAgent(
    item: AutomationItem,
    fireAt: number,
    source: AutomationTriggerSource,
    schedule: Schedule,
  ): Promise<boolean> {
    if (item.taskType !== 'agent' || item.lastStatus !== 'running') return false;
    if (item.lastFireAt === fireAt) return false;
    const reason = 'previous-run-unsettled' as const;
    const next = nextFireAfter(schedule, fireAt);
    const recorded = await this.store.recordSkippedFire(item.id, fireAt, reason, next);
    if (!recorded) return false;
    await this.store.recordLog({
      id: item.id,
      taskType: item.taskType,
      scheduledAt: fireAt,
      decidedAt: this.now(),
      triggerSource: source,
      result: 'skipped',
      skipReason: reason,
    });
    log.info('auto', 'skipped', { id: item.id, fireAt, reason });
    await this.writeStatus();
    return true;
  }

  private async dropChat(chatId: string): Promise<boolean> {
    const ok = await this.store.removeChat(chatId);
    if (ok) {
      log.info('auto', 'removed-from-chat', { chatId });
      await this.writeStatus();
    }
    this.armTimer();
    return ok;
  }

  private async handleDue(source: AutomationTriggerSource): Promise<void> {
    if (this.closed) return;
    if (!this.enabled()) {
      await this.expireDraftCards();
      this.armTimer();
      return;
    }
    if (this.isLinkUp()) this.linkSeenUp = true;
    await this.store.pruneStartedFireKeys(this.now());
    const now = this.now();
    if (!this.isLinkUp()) {
      for (const item of this.store.list()) {
        await this.skipUnsettledAgentSlots(item, source);
      }
      this.armTimer();
      return;
    }
    for (const item of this.store.list()) {
      if (item.paused || item.nextFireAt <= 0 || item.nextFireAt > now) continue;
      const schedule = readSchedule(item.schedule);
      if (!schedule) continue;
      const state = await this.skipUnsettledAgentSlots(item, source);
      const live = state.item;
      if (!live || live.paused || state.unsettled) continue;
      if (live.nextFireAt <= 0 || live.nextFireAt > now) continue;
      const liveSchedule = readSchedule(live.schedule);
      if (!liveSchedule) continue;
      if (live.nextFireAt < now - ON_TIME_GRACE_MS) {
        await this.applyCatchUp(live, source);
        continue;
      }
      await this.fireExact(live, live.nextFireAt, false, source, liveSchedule);
    }
    await this.expireDue();
    this.armTimer();
  }

  private async expireDraftCards(): Promise<void> {
    if (!this.isLinkUp()) return;
    try {
      await this.onExpireDrafts?.();
    } catch (error) {
      log.fail('auto', error, { event: 'draft-card' });
    }
  }

  private async expireDue(): Promise<void> {
    await this.expireDraftCards();
    const dropped = await this.store.dropAgedInstants();
    const now = this.now();
    let changed = false;
    for (const item of this.store.list()) {
      if (item.lastStatus === 'running') continue;
      const schedule = readSchedule(item.schedule);
      if (schedule?.kind === 'one-shot') {
        if (item.nextFireAt !== 0 || item.lastStatus !== 'missed') continue;
        if (item.missedInstants.length > 0) {
          const recordedAt = Math.min(...item.missedInstants.map((entry) => entry.recordedAt));
          if (now - recordedAt <= AUTOMATIONS_MISSED_TTL_MS) continue;
        }
        await this.store.delete(item.id);
        log.info('auto', 'expired', { id: item.id });
        changed = true;
        continue;
      }
      if (item.endAt > 0 && now >= item.endAt) {
        await this.store.delete(item.id);
        log.info('auto', 'expired', { id: item.id });
        changed = true;
      }
    }
    if (changed || dropped) await this.writeStatus();
  }

  private expiryAt(item: AutomationItem): number {
    if (item.lastStatus === 'running') return 0;
    const schedule = readSchedule(item.schedule);
    if (schedule?.kind === 'one-shot') {
      if (item.nextFireAt !== 0 || item.lastStatus !== 'missed') return 0;
      if (item.missedInstants.length === 0) return this.now();
      const recordedAt = Math.min(...item.missedInstants.map((entry) => entry.recordedAt));
      return recordedAt + AUTOMATIONS_MISSED_TTL_MS + 1;
    }
    if (item.nextFireAt === 0 && item.endAt > 0) {
      return item.endAt <= this.now() ? this.now() : item.endAt;
    }
    return 0;
  }

  private armTimer(): void {
    this.clearTimers();
    if (this.closed) return;
    const now = this.now();
    const deadline = this.enabled() ? this.nextDeadline(now) : this.nextDraftDeadline(now);
    if (deadline === undefined) return;
    const delay = Math.min(SCHEDULER_SEGMENT_MS, Math.max(0, deadline - now));
    this.fireTimer = this.setTimeout(() => {
      void this.enqueue(() => this.handleDue('timer'));
    }, delay);
  }

  private nextDeadline(now: number): number | undefined {
    const linkUp = this.isLinkUp();
    let next = Number.POSITIVE_INFINITY;
    for (const item of this.store.list()) {
      if (!item.paused && item.nextFireAt > 0) {
        if (item.nextFireAt > now || (linkUp && item.nextFireAt === now)) {
          next = Math.min(next, item.nextFireAt);
        } else if (
          item.taskType === 'agent'
          && item.lastStatus !== 'running'
          && readSchedule(item.schedule)
        ) {
          // A settle during skip can leave this slot overdue. Arm a segment
          // so it is not stuck until an unrelated nudge.
          next = Math.min(next, now + SCHEDULER_SEGMENT_MS);
        }
      }
      const expiry = this.expiryAt(item);
      if (expiry > 0) next = Math.min(next, expiry);
      for (const entry of item.missedInstants) {
        next = Math.min(next, entry.recordedAt + AUTOMATIONS_MISSED_TTL_MS + 1);
      }
      for (const entry of item.skippedInstants) {
        next = Math.min(next, entry.recordedAt + AUTOMATIONS_MISSED_TTL_MS + 1);
      }
    }
    const startedExpiry = this.store.earliestStartedKeyExpiry();
    if (startedExpiry !== undefined) next = Math.min(next, startedExpiry);
    const draftDeadline = this.nextDraftDeadline(now);
    if (draftDeadline !== undefined) next = Math.min(next, draftDeadline);
    return Number.isFinite(next) ? next : undefined;
  }

  private nextDraftDeadline(now: number): number | undefined {
    const expiry = nextDraftConfirmationExpiry(this.store);
    return expiry === undefined ? undefined : expiry <= now ? now + SCHEDULER_SEGMENT_MS : expiry;
  }

  private clearTimers(): void {
    if (this.fireTimer !== undefined) this.clearTimeout(this.fireTimer);
    this.fireTimer = undefined;
  }

  private armWakeWatch(): void {
    if (!this.wakeDir || this.wakeWatch || this.closed) return;
    const dir = this.wakeDir;
    this.wakeWatch = watchWakeDir(dir, (keys) => {
      for (const fireKey of keys) void this.wake(fireKey);
    });
  }

  private async drainWake(): Promise<void> {
    if (!this.wakeDir || this.closed) return;
    const keys = await consumeWakeRequests(this.wakeDir);
    for (const fireKey of keys) void this.wake(fireKey);
  }

  private async writeStatus(): Promise<void> {
    await this.store.writeStatus(this.botDisplayName());
    this.statusPusher?.notify();
    try {
      await this.onChanged?.();
    } catch (error) {
      log.fail('auto', error, { event: 'board' });
    }
  }
}
