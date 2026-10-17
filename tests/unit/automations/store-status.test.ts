import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from '../../../src/platform/atomic-write';
import { AutomationsStore } from '../../../src/automations/store';

vi.mock('../../../src/platform/atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/atomic-write')>();
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) };
});

const atomic = vi.mocked(writeFileAtomic);
const dirs: string[] = [];

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('../../../src/platform/atomic-write')>(
    '../../../src/platform/atomic-write',
  );
  atomic.mockReset().mockImplementation(actual.writeFileAtomic);
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
  ));
});

describe('AutomationsStore status writes', () => {
  it('does not keep lastStatus running when a later settle overwrites an in-flight snapshot', async () => {
    const actual = await vi.importActual<typeof import('../../../src/platform/atomic-write')>(
      '../../../src/platform/atomic-write',
    );
    const dir = await mkdtemp(join(tmpdir(), 'automations-status-'));
    dirs.push(dir);
    const statusPath = join(dir, 'automations-status.json');
    const store = new AutomationsStore({
      path: join(dir, 'automations.json'),
      logPath: join(dir, 'automations.log'),
      statusPath,
      now: () => 1_760_000_000_000,
    });
    await store.load();
    const item = await store.create({
      taskType: 'reminder',
      schedule: { type: 'one-shot', at: 1_760_000_000_000 },
      timezone: 'UTC',
      startAt: 1_760_000_000_000,
      endAt: 1_760_000_600_000,
      nextFireAt: 1_760_000_000_000,
      chatId: 'oc_group',
      createdBy: 'ou_alice',
      name: '交周报',
      taskText: '提醒交周报',
    });
    await store.markStarted(`${item.id}@${item.nextFireAt}`);
    expect(store.get(item.id)?.lastStatus).toBe('running');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let held = false;
    atomic.mockImplementation(async (path, data, opts) => {
      if (path === statusPath && !held) {
        held = true;
        entered();
        await gate;
      }
      return actual.writeFileAtomic(path, data, opts);
    });

    const stale = store.writeStatus('bot');
    await started;
    expect(await store.settleFire(item.id, 'ok')).toBe(true);
    const fresh = store.writeStatus('bot');
    release();
    await Promise.all([stale, fresh]);

    const status = JSON.parse(await readFile(statusPath, 'utf8')) as {
      items: Array<{ lastStatus: string }>;
    };
    expect(status.items[0]?.lastStatus).toBe('ok');
    expect(store.get(item.id)?.lastStatus).toBe('ok');
  });
});
