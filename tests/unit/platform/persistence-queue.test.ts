import { expect, it } from 'vitest';
import { PersistenceQueue } from '../../../src/platform/persistence-queue';

it('serializes writes and flush waits for the whole queue', async () => {
  const queue = new PersistenceQueue();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  queue.enqueue(async () => { events.push('start'); await gate; events.push('end'); });
  queue.enqueue(async () => { events.push('second'); });
  await Promise.resolve();
  expect(events).toEqual(['start']);
  release();
  await queue.flush();
  expect(events).toEqual(['start', 'end', 'second']);
});

it.each([new Error('first'), { reason: 'first' }, undefined])('retains the first failure, skips queued work, and observes non-Error throws: %s', async failure => {
  const queue = new PersistenceQueue();
  const writes: string[] = [];
  queue.enqueue(async () => { throw failure; });
  queue.enqueue(async () => { writes.push('must not run'); });
  await expect(queue.flush()).rejects.toBe(failure);
  await expect(queue.flush()).rejects.toBe(failure);
  expect(writes).toEqual([]);
  let thrown = false;
  try { queue.enqueue(async () => {}); } catch (error) { thrown = true; expect(error).toBe(failure); }
  expect(thrown).toBe(true);
});
