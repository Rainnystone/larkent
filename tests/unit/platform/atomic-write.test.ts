import { open, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from '../../../src/platform/atomic-write.js';

const cleanups: Array<() => Promise<void>> = [];

describe('atomic write retry', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('retries transient Windows rename failures and removes temp files', async () => {
    const root = await tmpRoot();
    const file = join(root, 'config.json');
    let attempts = 0;

    await writeFileAtomic(file, 'stable\n', {
      mode: 0o600,
      rename: async (from, to, fallbackRename) => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('busy') as NodeJS.ErrnoException;
          err.code = attempts === 1 ? 'EACCES' : 'EBUSY';
          throw err;
        }
        await fallbackRename(from, to);
      },
    });

    expect(attempts).toBe(3);
    await expect(readFile(file, 'utf8')).resolves.toBe('stable\n');
    expect((await readdir(root)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('bounds EPERM retries when the destination is missing instead of waiting a minute', async () => {
    // graceful-fs.rename retries that Windows AV case for up to 60s. Our
    // fallback must keep a short budget so a stuck rename fails fast.
    const root = await tmpRoot();
    const file = join(root, 'sessions.json');
    const started = Date.now();
    let attempts = 0;
    await expect(
      writeFileAtomic(file, '{}\n', {
        mode: 0o600,
        maxRenameAttempts: 4,
        retryDelayMs: 5,
        rename: async () => {
          attempts++;
          const err = new Error('locked') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        },
      }),
    ).rejects.toThrow('locked');
    expect(attempts).toBe(4);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('cleans up temp files when rename retries are exhausted', async () => {
    const root = await tmpRoot();
    const file = join(root, 'config.json');

    await expect(
      writeFileAtomic(file, 'stable\n', {
        mode: 0o600,
        rename: async () => {
          const err = new Error('busy') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        },
        maxRenameAttempts: 2,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow('busy');

    expect((await readdir(root)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('flushes the temp file before rename on the win32 path', async () => {
    const root = await tmpRoot();
    const file = join(root, 'durable.json');
    const probe = await open(join(root, 'probe'), 'w');
    const handleProto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const realPlatform = process.platform;
    const syncSpy = vi.spyOn(handleProto, 'sync');
    let syncedBeforeRename = false;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      await writeFileAtomic(file, 'payload\n', {
        rename: async (from, to, fallbackRename) => {
          syncedBeforeRename = syncSpy.mock.calls.length > 0;
          await fallbackRename(from, to);
        },
      });
      expect(syncedBeforeRename).toBe(true);
      // Windows cannot fsync directory handles, so only the file is synced.
      expect(syncSpy).toHaveBeenCalledTimes(1);
      await expect(readFile(file, 'utf8')).resolves.toBe('payload\n');
    } finally {
      syncSpy.mockRestore();
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'atomic-write-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
