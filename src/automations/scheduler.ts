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
}

export interface AutomationScheduler {
  start(): Promise<void>;
  stop(): void;
  idle(): Promise<void>;
  onLinkRecovered(): Promise<void>;
  wake(fireKey: string): Promise<void>;
  pause(id: number): Promise<boolean>;
  resume(id: number): Promise<boolean>;
  delete(id: number): Promise<boolean>;
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
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private fireTimer: unknown;
  private expireTimer: unknown;

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
  }

  start(): Promise<void> {
    this.closed = false;
    return this.enqueue(async () => {
      await this.catchUp('startup');
      await this.handleDue();
    });
  }

  stop(): void {
    this.closed = true;
    this.clearTimers();
  }

  idle(): Promise<void> {
    return this.chain;
  }

  onLinkRecovered(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) return;
      await this.catchUp('link-recovered');
      await this.handleDue();
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
      await this.catchUp('wake');
      await this.handleDue();
    });
  }

  pause(id: number): Promise<boolean> {
    return this.enqueue(async () => {
      const ok = await this.store.pause(id);
      if (ok) await this.writeStatus();
      this.armTimer();
      return ok;
    });
  }

  resume(id: number): Promise<boolean> {
    return this.enqueue(async () => {
      const item = this.store.get(id);
      if (!item) return false;
      const schedule = readSchedule(item.schedule);
      const next = schedule ? nextFireAfter(schedule, this.now()) : 0;
      const ok = await this.store.resume(id, next);
      if (ok && next === 0) await this.store.delete(id);
      if (ok) await this.writeStatus();
      this.armTimer();
      return ok;
    });
  }

  delete(id: number): Promise<boolean> {
    return this.enqueue(async () => {
      const ok = await this.store.delete(id);
      if (ok) await this.writeStatus();
      this.armTimer();
      return ok;
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => {},
      (error) => { log.fail('auto', error, { event: 'scheduler' }); },
    );
    return run;
  }

  private async catchUp(source: AutomationTriggerSource): Promise<void> {
    if (!this.enabled()) return;
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
    if (schedule.kind === 'one-shot' || next === 0) {
      await this.store.setNextFireAt(item.id, 0, item.lastStatus === 'running' ? 'ok' : item.lastStatus);
      await this.store.delete(item.id);
    } else {
      await this.store.setNextFireAt(
        item.id,
        next,
        item.lastStatus === 'running' ? 'ok' : item.lastStatus,
      );
    }
    await this.writeStatus();
  }

  private async applyCatchUp(item: AutomationItem, source: AutomationTriggerSource): Promise<void> {
    const live = this.store.get(item.id);
    if (!live || live.paused) return;
    const schedule = readSchedule(live.schedule);
    if (!schedule) return;
    const now = this.now();
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

    const newlyMissed: number[] = [];
    for (const fireAt of plan.missedFires) {
      const current = this.store.get(live.id);
      if (current?.missedInstants.some((entry) => entry.fireAt === fireAt)) continue;
      await this.store.recordMissedInstant(live.id, fireAt);
      newlyMissed.push(fireAt);
      await this.store.recordLog({
        id: live.id,
        taskType: live.taskType,
        scheduledAt: fireAt,
        decidedAt: now,
        triggerSource: source,
        result: 'missed',
      });
      log.info('auto', 'missed', { id: live.id, fireAt, triggerSource: source });
    }
    if (newlyMissed.length > 0) {
      await this.notifier.notify({
        id: live.id,
        missedFires: newlyMissed,
        chatId: live.chatId,
        name: live.name,
        timezone: live.timezone,
      });
    }

    if (plan.run !== undefined) {
      if (!this.isLinkUp()) {
        await this.store.setNextFireAt(live.id, plan.run);
        await this.writeStatus();
        return;
      }
      await this.fireExact(live, plan.run, true, source, schedule);
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
    const fireKey = formatFireKey(item.id, fireAt);
    const marked = await this.store.markStarted(fireKey);
    if (marked !== 'started') return;
    const now = this.now();
    const nextAfterFire = nextFireAfter(schedule, fireAt);
    const next = catchUp
      ? (nextAfterFire === now ? now : nextFireAfter(schedule, now))
      : nextAfterFire;
    if (schedule.kind === 'one-shot' || next === 0) {
      await this.store.setNextFireAt(item.id, 0, 'ok');
      await this.store.delete(item.id);
    } else {
      await this.store.setNextFireAt(item.id, next, 'ok');
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
    };
    void Promise.resolve(this.sender.send(payload)).then(
      () => {},
      (error) => { log.fail('auto', error, { event: catchUp ? 'catch-up' : 'fire' }); },
    );
  }

  private async handleDue(): Promise<void> {
    if (this.closed || !this.enabled()) return;
    const now = this.now();
    if (!this.isLinkUp()) {
      this.armTimer();
      return;
    }
    for (const item of this.store.list()) {
      if (item.paused || item.nextFireAt <= 0 || item.nextFireAt > now) continue;
      const schedule = readSchedule(item.schedule);
      if (!schedule) continue;
      if (item.nextFireAt < now) {
        await this.applyCatchUp(item, 'startup');
        continue;
      }
      await this.fireExact(item, item.nextFireAt, false, 'startup', schedule);
    }
    await this.expireDue();
    this.armTimer();
  }

  private async expireDue(): Promise<void> {
    const now = this.now();
    let changed = false;
    for (const item of this.store.list()) {
      const schedule = readSchedule(item.schedule);
      if (schedule?.kind !== 'one-shot') continue;
      if (item.nextFireAt !== 0 || item.lastStatus !== 'missed') continue;
      if (item.missedInstants.length > 0) {
        const recordedAt = Math.min(...item.missedInstants.map((entry) => entry.recordedAt));
        if (now - recordedAt <= AUTOMATIONS_MISSED_TTL_MS) continue;
      }
      await this.store.delete(item.id);
      changed = true;
    }
    if (changed) await this.writeStatus();
  }

  private expiryAt(item: AutomationItem): number {
    const schedule = readSchedule(item.schedule);
    if (schedule?.kind !== 'one-shot') return 0;
    if (item.nextFireAt !== 0 || item.lastStatus !== 'missed') return 0;
    if (item.missedInstants.length === 0) return this.now();
    const recordedAt = Math.min(...item.missedInstants.map((entry) => entry.recordedAt));
    return recordedAt + AUTOMATIONS_MISSED_TTL_MS + 1;
  }

  private armTimer(): void {
    this.clearTimers();
    if (this.closed || !this.enabled()) return;
    const now = this.now();
    const linkUp = this.isLinkUp();
    let nextFire = Number.POSITIVE_INFINITY;
    let nextExpire = Number.POSITIVE_INFINITY;
    for (const item of this.store.list()) {
      if (!item.paused && item.nextFireAt > 0) {
        if (item.nextFireAt > now || (linkUp && item.nextFireAt === now)) {
          nextFire = Math.min(nextFire, item.nextFireAt);
        }
      }
      const expiry = this.expiryAt(item);
      if (expiry > 0) nextExpire = Math.min(nextExpire, expiry);
    }
    if (Number.isFinite(nextFire)) {
      this.fireTimer = this.setTimeout(() => {
        void this.enqueue(() => this.handleDue());
      }, Math.max(0, nextFire - now));
    }
    if (Number.isFinite(nextExpire)) {
      this.expireTimer = this.setTimeout(() => {
        void this.enqueue(() => this.expireDue().then(() => this.armTimer()));
      }, Math.max(0, nextExpire - now));
    }
  }

  private clearTimers(): void {
    if (this.fireTimer !== undefined) this.clearTimeout(this.fireTimer);
    if (this.expireTimer !== undefined) this.clearTimeout(this.expireTimer);
    this.fireTimer = undefined;
    this.expireTimer = undefined;
  }

  private async writeStatus(): Promise<void> {
    await this.store.writeStatus(this.botDisplayName());
  }
}
