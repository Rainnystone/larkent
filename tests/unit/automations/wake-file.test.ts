import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  consumeWakeRequests,
  enqueueWakeRequest,
  watchWakeDir,
} from '../../../src/automations/wake-file';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
  ));
});

async function wakeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'automations-wake-'));
  dirs.push(dir);
  return join(dir, 'automations-wake');
}

describe('automation wake-request files', () => {
  it('enqueues a fire key, consumes it once, and ignores tmp files', async () => {
    const dir = await wakeDir();
    await enqueueWakeRequest(dir, '3@1792218600000');
    await enqueueWakeRequest(dir, '3@1792218600000');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.hidden-tmp.json'), '{"v":1,"fireKey":"9@1"}', { mode: 0o600 });

    const first = await consumeWakeRequests(dir);
    expect(first).toEqual(['3@1792218600000']);
    expect(await consumeWakeRequests(dir)).toEqual([]);
    const leftover = await readdir(dir);
    expect(leftover.some((name) => name.startsWith('.'))).toBe(true);
    expect(leftover.some((name) => name.endsWith('.json') && !name.startsWith('.'))).toBe(false);
  });

  it('notifies on a new request after watch starts', async () => {
    const dir = await wakeDir();
    const seen: string[][] = [];
    const watch = watchWakeDir(dir, (keys) => {
      seen.push(keys);
    });
    try {
      await enqueueWakeRequest(dir, '1@100');
      const deadline = Date.now() + 4000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(seen.flat()).toEqual(['1@100']);
      expect(await consumeWakeRequests(dir)).toEqual([]);
    } finally {
      watch.close();
    }
  });
});
