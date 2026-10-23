import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnJournal } from '../../src/bot/turn-journal';
import { isProcessAlive, readProcessStartMs } from '../../src/platform/process-info';
import { log } from '../../src/core/logger';

const dirs: string[] = [];
const pids: number[] = [];
// Windows spawns each fixture process several times slower than POSIX; keep
// the POSIX budget tight so genuine hangs still fail fast.
const TEST_TIMEOUT_MS = process.platform === 'win32' ? 30_000 : 15_000;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch { /* already gone */ }
  }
  await Promise.all(dirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
  ));
});

describe('turn journal orphan reaper', () => {
  it('reaps a live child after a simulated kill-9 restart and logs journal.recovered once', async () => {
    const child = spawnDetached();
    pids.push(child.pid);
    const dir = await mkdtemp(join(tmpdir(), 'journal-orphan-'));
    dirs.push(dir);
    const file = join(dir, 'turn-journal.json');
    const verifiedStart = readProcessStartMs(child.pid);
    const startedAt = verifiedStart ?? Date.now();
    const first = new TurnJournal(file);
    await first.load();
    first.enqueue({
      turnId: 'turn-orphan',
      scope: 'oc_group',
      chatId: 'oc_group',
      messageIds: ['om_1'],
      senderId: 'ou_user',
      initiatorId: 'ou_user',
      status: 'running',
      runId: 'run-orphan',
      childPid: child.pid,
      childStartedAt: startedAt,
    });
    await first.flush();
    expect(isProcessAlive(child.pid)).toBe(true);

    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const recovered = new TurnJournal(file);
    await recovered.load();
    await recovered.reapOrphans({ orphanGraceMs: 200 });
    await recovered.redeliver({ orphanGraceMs: 200 });
    await recovered.reapOrphans({ orphanGraceMs: 200 });
    await recovered.redeliver({ orphanGraceMs: 200 });

    expect(recovered.get('turn-orphan')?.status).toBe('interrupted');
    if (verifiedStart === undefined) {
      // Windows (and any OS that cannot read start time) must fail closed:
      // do not signal a PID we cannot identify, but still settle the journal
      // and log the interrupted recovery so the user is not left silent.
      expect(isProcessAlive(child.pid)).toBe(true);
      expect(info.mock.calls.filter(([phase, event]) => (
        phase === 'journal' && event === 'recovered'
      ))).toHaveLength(1);
      return;
    }
    expect(isProcessAlive(child.pid)).toBe(false);
    expect(info.mock.calls.filter(([phase, event]) => (
      phase === 'journal' && event === 'recovered'
    ))).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it.skipIf(process.platform === 'win32')(
    'leaves a detached child alive after SIGKILL of its parent, then reaps it on recover',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'journal-kill9-'));
      dirs.push(dir);
      const file = join(dir, 'turn-journal.json');
      const ready = join(dir, 'ready.json');
      const parent = spawn(process.execPath, ['-e', parentScript(file, ready)], {
        stdio: 'ignore',
        detached: true,
      });
      if (!parent.pid) throw new Error('failed to spawn parent');
      parent.unref();
      pids.push(parent.pid);
      const identity = await waitForJson(ready);
      pids.push(identity.childPid);
      expect(isProcessAlive(identity.childPid)).toBe(true);

      process.kill(parent.pid, 'SIGKILL');
      await waitUntil(() => !isProcessAlive(parent.pid!));
      expect(isProcessAlive(identity.childPid)).toBe(true);

      const info = vi.spyOn(log, 'info').mockImplementation(() => {});
      const journal = new TurnJournal(file);
      await journal.load();
      await journal.reapOrphans({ orphanGraceMs: 200 });
      await journal.redeliver({ orphanGraceMs: 200 });
      expect(isProcessAlive(identity.childPid)).toBe(false);
      expect(journal.get('turn-orphan')?.status).toBe('interrupted');
      expect(info.mock.calls.filter(([phase, event]) => (
        phase === 'journal' && event === 'recovered'
      ))).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
});

function spawnDetached(): { pid: number } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  if (!child.pid) throw new Error('failed to spawn orphan fixture');
  child.unref();
  return { pid: child.pid };
}

function parentScript(journalFile: string, readyFile: string): string {
  return `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const startedAt = Date.now();
    writeFileSync(${JSON.stringify(journalFile)}, JSON.stringify({
      schemaVersion: 1,
      entries: [{
        turnId: 'turn-orphan',
        scope: 'oc_group',
        chatId: 'oc_group',
        messageIds: ['om_1'],
        senderId: 'ou_user',
        initiatorId: 'ou_user',
        status: 'running',
        runId: 'run-orphan',
        childPid: child.pid,
        childStartedAt: startedAt,
        createdAt: startedAt,
        updatedAt: startedAt,
      }],
    }, null, 2) + '\\n');
    writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({ childPid: child.pid }));
    setInterval(() => {}, 1000);
  `;
}

async function waitForJson(path: string): Promise<{ childPid: number }> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as { childPid: number };
    } catch {
      await sleep(50);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error('timed out waiting for process transition');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
