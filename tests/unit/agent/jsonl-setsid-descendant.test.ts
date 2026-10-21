import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runJsonlCli, wrapParsedTranslator } from '../../../src/agent/runner/jsonl-cli-runner';

const FIXTURE = new URL('../../fixtures/setsid-grandchild.mjs', import.meta.url);

interface ProcIds {
  ppid: number;
  pgrp: number;
  sid: number;
  state: string;
}

function procIds(pid: number): ProcIds | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = text.slice(text.lastIndexOf(')') + 2).trim().split(' ');
    const state = rest[0];
    const ppid = Number(rest[1]);
    const pgrp = Number(rest[2]);
    const sid = Number(rest[3]);
    if (!state || !Number.isInteger(ppid) || !Number.isInteger(pgrp) || !Number.isInteger(sid)) {
      return undefined;
    }
    return { ppid, pgrp, sid, state };
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  const stat = procIds(pid);
  return stat !== undefined && stat.state !== 'Z';
}

describe('jsonl stop reaps setsid descendants', () => {
  const dirs: string[] = [];
  const owned: number[] = [];
  const siblings: ChildProcess[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      try {
        const pid = Number(readFileSync(join(dir, 'grandchild.pid'), 'utf8'));
        if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) owned.push(pid);
      } catch {
        // The grandchild never published a pid.
      }
    }
    for (const pid of owned.splice(0)) {
      if (pid === process.pid || pid <= 1) continue;
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    for (const sibling of siblings.splice(0)) {
      const pid = sibling.pid;
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== 'linux')(
    'kills a setsid grandchild that ignores SIGTERM within the stop grace',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-setsid-'));
      dirs.push(dir);
      const pidFile = join(dir, 'grandchild.pid');
      const stopGraceMs = 400;
      const sibling = spawn('sleep', ['300'], { stdio: 'ignore' });
      siblings.push(sibling);
      if (!sibling.pid) throw new Error('unrelated sleep failed to start');
      const run = runJsonlCli({
        runId: 'setsid',
        binaryPath: process.execPath,
        argv: [fileURLToPath(FIXTURE), pidFile],
        cwd: dir,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/tmp' },
        spawnName: 'fixture',
        stopGraceMs,
        translator: wrapParsedTranslator({ translate: () => [] }, 'fixture'),
      });
      if (run.pid) owned.push(run.pid);
      const grandchild = await waitForOutOfGroupChild(pidFile, run.pid!);
      owned.push(grandchild);
      const leader = procIds(run.pid!);
      const child = procIds(grandchild);
      expect(leader).toBeTruthy();
      expect(child?.ppid).toBe(run.pid);
      expect(child?.sid).not.toBe(leader?.sid);
      expect(child?.pgrp).not.toBe(leader?.pgrp);
      expect(alive(grandchild)).toBe(true);

      const started = Date.now();
      await run.stop();
      expect(Date.now() - started).toBeLessThan(stopGraceMs + 2000);
      expect(alive(grandchild)).toBe(false);
      expect(alive(run.pid!)).toBe(false);
      expect(run.signal).toBe('SIGTERM');
      expect(alive(process.pid)).toBe(true);
      expect(alive(sibling.pid!)).toBe(true);
    },
    10_000,
  );
});

async function waitForOutOfGroupChild(pidFile: string, leaderPid: number): Promise<number> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      const leader = procIds(leaderPid);
      const child = procIds(pid);
      if (
        Number.isInteger(pid) && pid > 1 && pid !== leaderPid && pid !== process.pid
        && leader && child && child.state !== 'Z'
        && child.ppid === leaderPid
        && child.sid !== leader.sid
        && child.pgrp !== leader.pgrp
      ) {
        return pid;
      }
    } catch {
      // The grandchild has not installed its SIGTERM handler yet.
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('setsid grandchild was not published');
}
