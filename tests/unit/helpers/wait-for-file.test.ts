import * as fs from 'node:fs/promises';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForPidFile } from '../../helpers/wait-for-file';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const { readFile } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const directories: string[] = [];
afterEach(async () => {
  vi.mocked(fs.readFile).mockImplementation(readFile);
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function readyPath() {
  const root = await mkdtemp(join(tmpdir(), 'fixture-pid-readiness-'));
  directories.push(root);
  return join(root, 'ready');
}

describe('scripted CLI PID readiness', () => {
  it('does not mistake a created but not yet written ready file for PID zero', async () => {
    const path = await readyPath();
    // Hold the real create/write boundary open: existence does not mean PID publication.
    const writer = await open(path, 'w');
    try {
      await expect(waitForPidFile(path, AbortSignal.timeout(100)))
        .rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      await writer.close();
    }
  });

  it.each(['0', '-1', 'NaN', '1.5', '1e3', '9007199254740992'])('rejects invalid PID content %s', async content => {
    const path = await readyPath();
    await writeFile(path, content);
    await expect(waitForPidFile(path, AbortSignal.timeout(100)))
      .rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('waits through an observed empty file and returns its subsequently published PID', async () => {
    const path = await readyPath();
    const writer = await open(path, 'w');
    let observedEmpty!: () => void;
    const emptyRead = new Promise<void>(resolve => { observedEmpty = resolve; });
    // Instrument real reads so publication waits for the empty-read boundary, not a sleep.
    vi.mocked(fs.readFile).mockImplementation(async (file, options) => {
      const content = await readFile(file, options);
      if (file === path && content === '') observedEmpty();
      return content;
    });
    const pid = waitForPidFile(path, AbortSignal.timeout(10_000));
    try {
      await Promise.race([emptyRead, pid]);
      await writer.writeFile('15089');
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
    await expect(waitForPidFile(path, AbortSignal.timeout(10_000))).resolves.toBe(15089);
  });

  it('accepts a positive PID published before observation', async () => {
    const path = await readyPath();
    await writeFile(path, '15089');
    await expect(waitForPidFile(path, AbortSignal.timeout(10_000))).resolves.toBe(15089);
  });
});
