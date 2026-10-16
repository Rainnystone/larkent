import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as nativeSetTimeout } from 'node:timers';
import * as lockfile from 'proper-lockfile';
import type { AppPaths } from '../config/app-paths';
import { RUNTIME_LOCK_SCHEMA_VERSION } from '../config/migrations';
import type { AgentKind } from '../config/profile-schema';
import { isAgentKind } from '../agent/registry';
import { isProcessAlive } from '../platform/process-info';

export type RuntimeLockKind = 'profile' | 'app';

export interface AcquiredRuntimeLock {
  kind: RuntimeLockKind;
  target: string;
  release(): Promise<void>;
}

export interface RuntimeLockMeta {
  schemaVersion: number;
  kind: RuntimeLockKind;
  target: string;
  profile: string;
  agentKind: AgentKind;
  appId?: string;
  pid: number;
  startedAt: string;
}

export class RuntimeLockConflictError extends Error {
  constructor(
    readonly kind: RuntimeLockKind,
    readonly target: string,
    readonly meta: RuntimeLockMeta | undefined,
    cause: unknown,
  ) {
    super(`runtime ${kind} lock is already held: ${target}`);
    this.name = 'RuntimeLockConflictError';
    this.cause = cause;
  }
}

export async function withProfileAndAppLocks<T>(
  paths: Pick<AppPaths, 'profile' | 'profileLockFile' | 'appLockFile'>,
  appId: string,
  agentKind: AgentKind,
  fn: (locks: AcquiredRuntimeLock[]) => Promise<T> | T,
): Promise<T> {
  const acquired: AcquiredRuntimeLock[] = [];
  try {
    acquired.push(
      await acquireRuntimeLock({
        kind: 'profile',
        target: paths.profileLockFile,
        profile: paths.profile,
        agentKind,
      }),
    );
    acquired.push(await acquireAppRuntimeLock(paths, appId, agentKind));
    return await fn([...acquired]);
  } finally {
    for (const lock of acquired.reverse()) {
      await lock.release().catch(() => {});
    }
  }
}

export async function acquireAppRuntimeLock(
  paths: Pick<AppPaths, 'profile' | 'appLockFile'>,
  appId: string,
  agentKind: AgentKind,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AcquiredRuntimeLock> {
  const perRoot = await acquireRuntimeLock({
    kind: 'app',
    target: paths.appLockFile(appId),
    profile: paths.profile,
    agentKind,
    appId,
  });
  try {
    const machine = await acquireMachineAppLock({
      appId,
      profile: paths.profile,
      agentKind,
      env,
    });
    return {
      kind: 'app',
      target: perRoot.target,
      async release() {
        await machine.release().catch(() => {});
        await perRoot.release();
      },
    };
  } catch (err) {
    await perRoot.release().catch(() => {});
    throw err;
  }
}

/**
 * Machine-wide app lock path. Independent of `LARK_CHANNEL_HOME` so two data
 * roots cannot silently split the same Feishu app. The file name is a hash;
 * the path never contains the plaintext app id.
 */
export function machineAppLockFile(appId: string, env: NodeJS.ProcessEnv = process.env): string {
  const digest = createHash('sha256').update(appId).digest('hex');
  const root = env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, 'larkent', 'locks', 'app')
    : join(homedir(), '.cache', 'larkent', 'locks', 'app');
  return join(root, `${digest}.lock`);
}

export async function acquireMachineAppLock(input: {
  appId: string;
  profile: string;
  agentKind: AgentKind;
  env?: NodeJS.ProcessEnv;
}): Promise<AcquiredRuntimeLock> {
  return acquireRuntimeLock({
    kind: 'app',
    target: machineAppLockFile(input.appId, input.env),
    profile: input.profile,
    agentKind: input.agentKind,
  });
}

export async function acquireProfileRuntimeLock(
  paths: Pick<AppPaths, 'profile' | 'profileLockFile'>,
  agentKind: AgentKind,
): Promise<AcquiredRuntimeLock> {
  return acquireRuntimeLock({
    kind: 'profile',
    target: paths.profileLockFile,
    profile: paths.profile,
    agentKind,
  });
}

export function runtimeLockMetaFile(target: string): string {
  return `${target}.meta.json`;
}

export function runtimeLockPidFile(target: string): string {
  return `${target}.pid`;
}

export async function readRuntimeLockMeta(target: string): Promise<RuntimeLockMeta | undefined> {
  try {
    const parsed = JSON.parse(await readFile(runtimeLockMetaFile(target), 'utf8')) as unknown;
    return isRuntimeLockMeta(parsed) ? parsed : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

export async function checkRuntimeLock(target: string): Promise<{
  locked: boolean;
  meta?: RuntimeLockMeta;
  uncertain?: boolean;
  error?: string;
}> {
  try {
    const locked = await lockfile.check(target, { realpath: false });
    if (!locked) return { locked: false };
    const meta = await readRuntimeLockMeta(target);
    if (!meta) {
      return { locked: true, uncertain: true, error: 'missing-or-invalid-runtime-lock-meta' };
    }
    return { locked: true, meta };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { locked: false };
    return {
      locked: true,
      uncertain: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function acquireRuntimeLock(
  meta: Omit<RuntimeLockMeta, 'schemaVersion' | 'pid' | 'startedAt'>,
): Promise<AcquiredRuntimeLock> {
  await mkdir(dirname(meta.target), { recursive: true });
  await writeFile(meta.target, '', { flag: 'a', mode: 0o600 });
  await chmod(meta.target, 0o600);

  let release: () => Promise<void>;
  try {
    release = await lockWithDeadHolderTakeover(meta);
  } catch (err) {
    throw new RuntimeLockConflictError(meta.kind, meta.target, await readRuntimeLockMeta(meta.target), err);
  }

  const fullMeta: RuntimeLockMeta = {
    schemaVersion: RUNTIME_LOCK_SCHEMA_VERSION,
    ...meta,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  // Sidecar only — never rewrite the lock target after acquire. Machine app
  // targets are already named `*.lock`; replacing that file on Windows can
  // leave proper-lockfile's directory lock stuck for the rest of the worker.
  const pidFile = runtimeLockPidFile(meta.target);
  await writeFile(pidFile, `${process.pid}\n`, { mode: 0o600 });
  const metaFile = runtimeLockMetaFile(meta.target);
  await writeFile(metaFile, `${JSON.stringify(fullMeta, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(metaFile, 0o600);

  return {
    kind: meta.kind,
    target: meta.target,
    async release() {
      await unlink(pidFile).catch(() => {});
      await unlink(metaFile).catch(() => {});
      await release();
    },
  };
}

async function lockWithDeadHolderTakeover(
  meta: Omit<RuntimeLockMeta, 'schemaVersion' | 'pid' | 'startedAt'>,
): Promise<() => Promise<void>> {
  try {
    return await lockfile.lock(meta.target, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: 0,
    });
  } catch (err) {
    const pid = await readLockHolderPid(meta.target);
    // Unknown holder: do not steal — a live second instance may own the lock
    // without a readable sidecar. Dead recorded pid: reclaim immediately.
    if (pid === undefined || pid === process.pid || isProcessAlive(pid)) {
      throw err;
    }
    await stealDeadHolderLock(meta.target);
    return await lockfile.lock(meta.target, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: 0,
    });
  }
}

async function readLockHolderPid(target: string): Promise<number | undefined> {
  const holder = await readRuntimeLockMeta(target);
  if (isUsablePid(holder?.pid)) return holder.pid;
  try {
    const raw = (await readFile(runtimeLockPidFile(target), 'utf8')).trim();
    const pid = Number(raw);
    return isUsablePid(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isUsablePid(pid: number | undefined): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

async function stealDeadHolderLock(target: string): Promise<void> {
  // proper-lockfile.unlock from another process often leaves `${target}.lock`
  // in place after kill -9. Force-remove that leftover so we do not wait
  // for the 30s stale timer.
  await rm(`${target}.lock`, { recursive: true, force: true }).catch(() => {});
  try {
    await lockfile.unlock(target, { realpath: false });
  } catch {
    // Lock file may already be gone; still drop the stale pid sidecar.
  }
  await unlink(runtimeLockPidFile(target)).catch(() => {});
  const metaFile = runtimeLockMetaFile(target);
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      await unlink(metaFile);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt === 8) return;
      await new Promise((resolve) => nativeSetTimeout(resolve, 20 * attempt));
    }
  }
}

function isRuntimeLockMeta(value: unknown): value is RuntimeLockMeta {
  if (!value || typeof value !== 'object') return false;
  const meta = value as Partial<RuntimeLockMeta>;
  const schemaVersion = meta.schemaVersion;
  if (schemaVersion !== undefined && schemaVersion !== RUNTIME_LOCK_SCHEMA_VERSION) return false;
  return (
    (meta.kind === 'profile' || meta.kind === 'app') &&
    typeof meta.target === 'string' &&
    typeof meta.profile === 'string' &&
    isAgentKind(meta.agentKind) &&
    typeof meta.pid === 'number' &&
    typeof meta.startedAt === 'string' &&
    (meta.appId === undefined || typeof meta.appId === 'string')
  );
}
