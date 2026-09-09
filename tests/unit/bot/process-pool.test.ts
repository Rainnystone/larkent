import { describe, expect, it } from 'vitest';
import { ProcessPool } from '../../../src/bot/process-pool';

describe('ProcessPool pending cancellation', () => {
  it('cancels waiters without releasing active ownership and accepts later work', async () => {
    const pool = new ProcessPool(() => 1);
    const active = await pool.acquire();
    expect(active).toBeTypeOf('function');
    if (!active) throw new Error('first acquisition should have a slot');
    const waiting = [pool.acquire(), pool.acquire()];
    expect(pool.snapshot()).toEqual({ active: 1, waiting: 2, cap: 1 });
    pool.cancelPending();
    expect(await Promise.all(waiting)).toEqual([undefined, undefined]);
    expect(pool.snapshot()).toEqual({ active: 1, waiting: 0, cap: 1 });
    expect(pool.tryAcquire()).toBeUndefined();
    pool.cancelPending();
    active();
    const next = await pool.acquire();
    expect(next).toBeTypeOf('function');
    if (!next) throw new Error('next acquisition should have a slot');
    next();
    expect(pool.snapshot()).toEqual({ active: 0, waiting: 0, cap: 1 });
  });

  it('keeps FIFO waiting, the concurrency cap and tryAcquire behavior', async () => {
    let cap = 1;
    const pool = new ProcessPool(() => cap);
    const active = pool.tryAcquire();
    expect(active).toBeTypeOf('function');
    if (!active) throw new Error('first acquisition should have a slot');
    expect(pool.tryAcquire()).toBeUndefined();
    const order: string[] = [];
    const first = pool.acquire().then(release => { order.push('first'); return release; });
    const second = pool.acquire().then(release => { order.push('second'); return release; });
    active();
    const releaseFirst = await first;
    expect(order).toEqual(['first']);
    expect(pool.snapshot()).toEqual({ active: 1, waiting: 1, cap: 1 });
    if (!releaseFirst) throw new Error('first waiter should have a slot');
    releaseFirst();
    const releaseSecond = await second;
    expect(order).toEqual(['first', 'second']);
    if (!releaseSecond) throw new Error('second waiter should have a slot');
    releaseSecond();
    cap = 2;
    const a = pool.tryAcquire();
    const b = pool.tryAcquire();
    expect(pool.tryAcquire()).toBeUndefined();
    if (!a || !b) throw new Error('raised cap should allow two slots');
    a(); b();
    expect(pool.snapshot()).toEqual({ active: 0, waiting: 0, cap: 2 });
  });
});
