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

  it.skipIf(process.platform === 'win32')('flushes the temp file before rename on POSIX', async () => {
    const root = await tmpRoot();
    const file = join(root, 'durable.json');
    const probe = await open(join(root, 'probe'), 'w');
    const handleProto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const syncSpy = vi.spyOn(handleProto, 'sync');
    try {
      await writeFileAtomic(file, 'payload\n', {
        rename: async (from, to, fallbackRename) => {
          expect(syncSpy).toHaveBeenCalledTimes(1);
          await fallbackRename(from, to);
        },
      });
      await expect(readFile(file, 'utf8')).resolves.toBe('payload\n');
    } finally {
      syncSpy.mockRestore();
    }
  });

  it('closes the Windows temp handle without fsync so AV cannot pin it across rename', async () => {
    const root = await tmpRoot();
    const file = join(root, 'durable.json');
    const probe = await open(join(root, 'probe'), 'w');
    const handleProto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const realPlatform = process.platform;
    const syncSpy = vi.spyOn(handleProto, 'sync');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      await writeFileAtomic(file, 'payload\n', {
        rename: async (from, to, fallbackRename) => {
          expect(syncSpy).not.toHaveBeenCalled();
          await fallbackRename(from, to);
        },
      });
      expect(syncSpy).not.toHaveBeenCalled();
      await expect(readFile(file, 'utf8')).resolves.toBe('payload\n');
    } finally {
      syncSpy.mockRestore();
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });

  it('keeps two sequential Windows startup persists inside 2s when AV returns EPERM until the last attempt', async () => {
    // Supervisor start-stop: missing sessions persist, later store fails, repaired
    // retry persists workspaces. Linear 40ms*attempt backoff is 2.6s per write and
    // the 5s test dies mid-retry with no errno — same shape as Windows CI.
    const root = await tmpRoot();
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const started = Date.now();
      for (const name of ['sessions.json', 'workspaces.json']) {
        let attempts = 0;
        await writeFileAtomic(join(root, name), '{}\n', {
          rename: async (from, to, fallbackRename) => {
            attempts++;
            if (attempts < 12) {
              const err = new Error('locked') as NodeJS.ErrnoException;
              err.code = 'EPERM';
              throw err;
            }
            await fallbackRename(from, to);
          },
        });
        expect(attempts).toBe(12);
      }
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'atomic-write-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
