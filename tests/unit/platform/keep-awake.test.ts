import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  KEEP_AWAKE_ACQUIRE_TIMEOUT_MS,
  KEEP_AWAKE_RELEASE_TIMEOUT_MS,
  createKeepAwake,
  type KeepAwakeOptions,
} from '../../../src/platform/keep-awake';

const POWERSHELL = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

type SpawnFn = NonNullable<KeepAwakeOptions['spawn']>;
type Holder = ChildProcess & { kill: ReturnType<typeof vi.fn> };

/** Mimics the real holder: it exits on stdin EOF unless told to hang. */
function holder(opts: { exitOnEof?: boolean } = {}): Holder {
  const child = new EventEmitter() as unknown as Holder;
  const stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
  Object.assign(child, {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    kill: vi.fn(() => true),
  });
  if (opts.exitOnEof !== false) stdin.on('finish', () => setImmediate(() => exit(child, 0)));
  return child;
}

function exit(child: Holder, code: number) {
  // `exitCode` is readonly on the type; a real child sets it just before 'exit'.
  Object.assign(child, { exitCode: code });
  child.emit('exit', code, null);
}

function harness(opts: Partial<KeepAwakeOptions> = {}, holderOpts: { exitOnEof?: boolean } = {}) {
  const child = holder(holderOpts);
  const spawn = vi.fn<SpawnFn>(() => child);
  const warn = vi.fn();
  const keepAwake = createKeepAwake({
    platform: 'win32',
    powershellPath: POWERSHELL,
    spawn,
    warn,
    acquireTimeoutMs: KEEP_AWAKE_ACQUIRE_TIMEOUT_MS,
    releaseTimeoutMs: KEEP_AWAKE_RELEASE_TIMEOUT_MS,
    ...opts,
  });
  return { child, spawn, warn, keepAwake };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function expectWarnedOnce(warn: ReturnType<typeof vi.fn>, event: string, fields: unknown) {
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(event, fields);
}

describe('keep-awake holder', () => {
  it('does nothing on a platform without a holder and says why', async () => {
    const { spawn, warn, keepAwake } = harness({ platform: 'linux' });

    expect(await keepAwake.acquire()).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
    expectWarnedOnce(warn, 'unsupported-platform', { platform: 'linux' });
  });

  it('spawns Windows PowerShell with the script passed inline and no window', async () => {
    const { child, spawn, keepAwake } = harness();
    const pending = keepAwake.acquire();
    child.stdout!.emit('data', 'held\n');
    (await pending)!.release();
    await tick();

    const [command, args, options] = spawn.mock.calls[0]!;
    expect(command).toBe(POWERSHELL);
    expect(args!.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    // The request is ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1),
    // cleared again with ES_CONTINUOUS alone once stdin reaches EOF.
    expect(args![3]).toContain('SetThreadExecutionState');
    expect(args![3]).toContain('2147483649');
    expect(args![3]).toContain('2147483648');
    expect(options!.windowsHide).toBe(true);
    expect(options!.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('reports held only after a guarded request: a failed binding stops the holder', async () => {
    const { child, spawn, keepAwake } = harness();
    const pending = keepAwake.acquire();
    child.stdout!.emit('data', 'held\n');
    (await pending)!.release();
    await tick();

    const script = String(spawn.mock.calls[0]![1]![3]);
    // PowerShell keeps going past a failed statement in a `-Command` string, so
    // without the guard a holder that never got its request would still say held.
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    const guarded = script.indexOf('try {');
    const caught = script.indexOf('catch {');
    const confirmed = script.indexOf("WriteLine('held')");
    expect(guarded).toBeGreaterThan(0);
    expect(caught).toBeGreaterThan(guarded);
    expect(confirmed).toBeGreaterThan(caught);
  });

  it('passes the injected type definition inline with single quotes escaped', async () => {
    const { child, spawn, keepAwake } = harness({ typeDefinition: "public static class Q { } // it's injected" });
    const pending = keepAwake.acquire();
    child.stdout!.emit('data', 'held\n');
    (await pending)!.release();
    await tick();

    const script = String(spawn.mock.calls[0]![1]![3]);
    expect(script).toContain("$sig = 'public static class Q { } // it''s injected'");
  });

  it('resolves only once the holder confirms, then releases it through stdin EOF', async () => {
    const { child, keepAwake } = harness();
    const pending = keepAwake.acquire();
    let settled = false;
    void pending.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);

    child.stdout!.emit('data', 'hel');
    await tick();
    expect(settled).toBe(false);

    child.stdout!.emit('data', 'd\n');
    const handle = await pending;
    expect(handle).toBeDefined();

    const end = vi.spyOn(child.stdin!, 'end');
    await handle!.release();
    expect(end).toHaveBeenCalledTimes(1);
    expect(child.exitCode).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    ['exits', (child: Holder) => exit(child, 1)],
    ['fails to spawn', (child: Holder) => child.emit('error', new Error('spawn powershell ENOENT'))],
  ])('returns undefined and warns when the holder %s before confirming', async (_case, fail) => {
    const { child, warn, keepAwake } = harness();
    const pending = keepAwake.acquire();
    fail(child);

    expect(await pending).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe('holder-not-started');
  });

  it('gives up when the holder never confirms, and does not leave it behind', async () => {
    const { child, warn, keepAwake } = harness({ acquireTimeoutMs: 20 });

    expect(await keepAwake.acquire()).toBeUndefined();
    expectWarnedOnce(warn, 'holder-not-started', expect.objectContaining({ reason: 'timeout' }));
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('warns when the holder dies while held, leaving nothing to release', async () => {
    const { child, warn, keepAwake } = harness();
    const pending = keepAwake.acquire();
    child.stdout!.emit('data', 'held\n');
    const handle = (await pending)!;

    exit(child, 1);
    await tick();
    expectWarnedOnce(warn, 'holder-exited', expect.objectContaining({ code: 1 }));

    const end = vi.spyOn(child.stdin!, 'end');
    await handle.release();
    expect(end).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('kills a holder that ignores EOF once the release timeout passes', async () => {
    const { child, keepAwake } = harness({ releaseTimeoutMs: 20 }, { exitOnEof: false });
    const pending = keepAwake.acquire();
    child.stdout!.emit('data', 'held\n');

    await (await pending)!.release();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('takes a stream error from a holder that died an instant ago in stride', async () => {
    const { child, warn, keepAwake } = harness();
    const pending = keepAwake.acquire();
    child.stdout!.emit('data', 'held\n');
    const handle = (await pending)!;

    // The holder is gone but its exit is not reported yet: the stdin write hits a closed pipe.
    expect(() => child.stdin!.emit('error', new Error('write EPIPE'))).not.toThrow();
    await expect(handle.release()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats release as idempotent', async () => {
    const { child, keepAwake } = harness();
    const pending = keepAwake.acquire();
    child.stdout!.emit('data', 'held\n');
    const handle = (await pending)!;

    const end = vi.spyOn(child.stdin!, 'end');
    await handle.release();
    await handle.release();
    expect(end).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
