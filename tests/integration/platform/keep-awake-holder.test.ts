import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createKeepAwake, type KeepAwakeOptions } from '../../../src/platform/keep-awake';
import { spawnProcess } from '../../../src/platform/spawn';

// Runs the real holder script on Windows PowerShell. The unit tests drive a
// fake child, so they cannot tell whether the script itself still compiles its
// binding, asks for the right thing, or reports `held` only once it holds.
describe.skipIf(process.platform !== 'win32')('keep-awake holder on real Windows PowerShell', () => {
  const TIMEOUT_MS = 120_000;

  function realHolderSource(opts: Partial<KeepAwakeOptions> = {}) {
    const children: ChildProcess[] = [];
    const spawn: NonNullable<KeepAwakeOptions['spawn']> = (command, args, options) => {
      const child = spawnProcess(command, args, options);
      children.push(child);
      return child;
    };
    const warn = vi.fn();
    const keepAwake = createKeepAwake({ spawn, warn, acquireTimeoutMs: 60_000, ...opts });
    return { children, warn, keepAwake };
  }

  it('holds a real request and exits once released', async () => {
    const { children, warn, keepAwake } = realHolderSource();

    const handle = await keepAwake.acquire();

    expect(handle).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
    expect(children[0]!.exitCode).toBeNull();

    await handle!.release();

    expect(children[0]!.exitCode).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  }, TIMEOUT_MS);

  it('does not report held when its binding cannot compile', async () => {
    const { children, warn, keepAwake } = realHolderSource({ typeDefinition: 'this is not C#' });

    const handle = await keepAwake.acquire();
    // A wrong result must not leave a real holder parked on stdin.
    await handle?.release();

    expect(handle).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const [event, fields] = warn.mock.calls[0]! as [string, Record<string, unknown>];
    expect(event).toBe('holder-not-started');
    expect(fields).toMatchObject({ reason: 'exited', code: 1 });
    expect(String(fields.stderr)).not.toBe('');
    expect(children[0]!.exitCode).toBe(1);
  }, TIMEOUT_MS);
});
