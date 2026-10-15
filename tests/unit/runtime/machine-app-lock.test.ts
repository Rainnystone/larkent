import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireMachineAppLock,
  machineAppLockFile,
  RuntimeLockConflictError,
} from '../../../src/runtime/locks';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('machine-level app lock', () => {
  it('places the lock outside LARK_CHANNEL_HOME and hashes the app id', () => {
    const runtimeDir = join(tmpdir(), 'larkent-xdg-runtime-path');
    const homeA = join(tmpdir(), 'larkent-home-a');
    const homeB = join(tmpdir(), 'larkent-home-b');
    const appId = 'cli_fake_app_id_0a';
    const env = { XDG_RUNTIME_DIR: runtimeDir, LARK_CHANNEL_HOME: homeA };
    const path = machineAppLockFile(appId, env);

    expect(path).toBe(
      join(runtimeDir, 'larkent', 'locks', 'app', `${sha256(appId)}.lock`),
    );
    expect(path).not.toContain(appId);
    expect(path).not.toContain(homeA);
    expect(machineAppLockFile(appId, { ...env, LARK_CHANNEL_HOME: homeB })).toBe(path);
  });

  it('rejects a second holder and recovers after release or a stale lock', async () => {
    const lockDir = await tempDir('larkent-machine-lock-');
    const env = { XDG_RUNTIME_DIR: lockDir };
    const appId = 'cli_fake_app_id_0a';
    const first = await acquireMachineAppLock({ appId, profile: 'a', agentKind: 'claude', env });

    await expect(
      acquireMachineAppLock({ appId, profile: 'b', agentKind: 'claude', env }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(RuntimeLockConflictError);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(appId);
      return true;
    });

    await first.release();
    const second = await acquireMachineAppLock({
      appId,
      profile: 'b',
      agentKind: 'claude',
      env,
    });
    await second.release();

    const staleLockfile = `${machineAppLockFile(appId, env)}.lock`;
    await mkdir(staleLockfile, { recursive: true });
    const past = new Date(Date.now() - 60_000);
    await utimes(staleLockfile, past, past);
    const recovered = await acquireMachineAppLock({
      appId,
      profile: 'c',
      agentKind: 'claude',
      env,
    });
    await recovered.release();
  });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
