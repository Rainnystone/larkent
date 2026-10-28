import { EventEmitter } from 'node:events';
import * as nativeFs from 'node:fs';
import type { FSWatcher, WatchListener } from 'node:fs';
import * as fs from 'node:fs/promises';
import { mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForPidFile } from '../../helpers/wait-for-file';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const { readFile } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const { watch } = await vi.importActual<typeof import('node:fs')>('node:fs');
const directories: string[] = [];
const writers: FileHandle[] = [];
const waits: Array<{ abort: () => void; settled: Promise<void> }> = [];
afterEach(async () => {
  // Vitest's deadline does not cancel a pending watcher or close its writer.
  for (const wait of waits) wait.abort();
  await Promise.all(waits.splice(0).map(wait => wait.settled));
  await Promise.all(writers.splice(0).map(writer => writer.close()));
  await Promise.allSettled(vi.mocked(fs.readFile).mock.results.map(result => result.value));
  vi.mocked(fs.readFile).mockReset().mockImplementation(readFile);
  vi.mocked(nativeFs.watch).mockReset().mockImplementation(watch);
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function readyPath() {
  const root = await mkdtemp(join(tmpdir(), 'fixture-pid-readiness-'));
  directories.push(root);
  return join(root, 'ready');
}

async function openWriter(path: string) {
  const writer = await open(path, 'w');
  writers.push(writer);
  return writer;
}

function observePid(path: string, timeout = 10_000) {
  const stop = new AbortController();
  const deadline = setTimeout(() => stop.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), timeout);
  const pending = waitForPidFile(path, stop.signal);
  waits.push({ abort: () => stop.abort(), settled: pending.then(() => {}, () => {}).then(() => clearTimeout(deadline)) });
  return pending;
}

describe('scripted CLI PID readiness', () => {
  it('does not mistake a created but not yet written ready file for PID zero', async () => {
    const path = await readyPath();
    // Hold the real create/write boundary open: existence does not mean PID publication.
    const writer = await openWriter(path);
    try {
      await expect(observePid(path, 100))
        .rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      await writer.close();
    }
  });

  it('reaches its deadline when garbage collection runs during the wait', async () => {
    const path = await readyPath();
    const pid = observePid(path, 100);
    // WeakRef targets survive until the current job ends, so collect on a later turn.
    await new Promise(resolve => setImmediate(resolve));
    setFlagsFromString('--expose-gc');
    runInNewContext('gc')();
    await expect(pid).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it.each(['0', '-1', 'NaN', '1.5', '1e3', '9007199254740992'])('rejects invalid PID content %s', async content => {
    const path = await readyPath();
    await writeFile(path, content);
    await expect(observePid(path, 100))
      .rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it.each(['native', 'after writer close'])('waits through an observed empty file with %s notifications', async notifications => {
    const path = await readyPath();
    const writer = await openWriter(path);
    if (notifications === 'after writer close') {
      // Windows may not publish the last-write notification until the writer closes.
      let notify!: WatchListener<string>;
      let watching = true;
      const watcher = Object.assign(new EventEmitter(), {
        close() { watching = false; },
      }) as FSWatcher;
      vi.mocked(nativeFs.watch).mockImplementationOnce((directory, listener) => {
        expect(directory).toBe(join(path, '..'));
        notify = listener as WatchListener<string>;
        return watcher;
      });
      const close = writer.close.bind(writer);
      vi.spyOn(writer, 'close').mockImplementation(async () => {
        const wasOpen = writer.fd !== -1;
        await close();
        if (wasOpen && watching) notify('change', basename(path));
      });
    }
    let observedEmpty!: () => void;
    const emptyRead = new Promise<void>(resolve => { observedEmpty = resolve; });
    // Instrument real reads so publication waits for the empty-read boundary, not a sleep.
    vi.mocked(fs.readFile).mockImplementation(async (file, options) => {
      const content = await readFile(file, options);
      if (file === path && content === '') observedEmpty();
      return content;
    });
    const pid = observePid(path);
    try {
      await Promise.race([emptyRead, pid]);
      await writer.writeFile('15089');
      // Match writeFileSync's publication: close before awaiting the notification.
      await writer.close();
      await expect(pid).resolves.toBe(15089);
    } finally {
      await writer.close();
    }
  });

  it('retains the accepted PID snapshot rather than reading the file again', async () => {
    const path = await readyPath();
    await writeFile(path, '15089');
    vi.mocked(fs.readFile).mockImplementation(async (file, options) => {
      const content = await readFile(file, options);
      if (file === path && content === '15089') await writeFile(path, '');
      return content;
    });
    await expect(observePid(path)).resolves.toBe(15089);
  });

  it('accepts a positive PID published before observation', async () => {
    const path = await readyPath();
    await writeFile(path, '15089');
    await expect(observePid(path)).resolves.toBe(15089);
  });
});
