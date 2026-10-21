import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessToClaudePermissionMode, accessToCodexSandbox } from '../../../src/config/permissions';
import type { EffectiveAccess } from '../../../src/agent/types';

const spawnMock = vi.hoisted(() => ({ spawnProcess: vi.fn() }));
vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import { GrokAdapter } from '../../../src/agent/grok/adapter';
import { grokAccessFlags, grokAccessStatus } from '../../../src/agent/grok/options';
import { grokMetadata } from '../../../src/agent/grok/metadata';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

function argvOfLastSpawn(): string[] {
  const options = spawnMock.spawnProcess.mock.calls.at(-1)?.[1] as string[] | undefined;
  return options ?? [];
}

describe('Grok access flags', () => {
  beforeEach(() => {
    spawnMock.spawnProcess.mockReset();
    spawnMock.spawnProcess.mockReturnValue(Object.assign(new EventEmitter(), {
      pid: 42,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    }));
  });

  afterEach(() => {
    spawnMock.spawnProcess.mockReset();
  });

  it.each(['read-only', 'workspace', 'full'] as const)(
    'maps %s onto grok permission-mode and sandbox',
    (access: EffectiveAccess) => {
      new GrokAdapter({ binary: 'grok' }).run({
        runId: 'r1',
        prompt: 'hi',
        cwd: '/tmp',
        permissionMode: accessToClaudePermissionMode(access),
        sandbox: accessToCodexSandbox(access),
      });
      const argv = argvOfLastSpawn();
      const flags = grokAccessFlags(access);
      expect(argv[argv.indexOf('--permission-mode') + 1]).toBe(flags.permissionMode);
      expect(argv[argv.indexOf('--sandbox') + 1]).toBe(flags.sandbox);
      if (access === 'read-only') expect(argv).not.toContain('--always-approve');
      if (access === 'full') expect(argv).not.toContain('--always-approve');
    },
  );

  it('keeps --always-approve when the run does not name an access mode', () => {
    new GrokAdapter({ binary: 'grok' }).run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });
    expect(argvOfLastSpawn()).toContain('--always-approve');
  });

  it('describes the same flags runtimeAccess puts on the status line', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'grok',
      accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    });
    const access = profile.permissions.defaultAccess;
    const status = grokMetadata.runtimeAccess(profile);
    expect(status.value).toBe(grokAccessStatus(access));
    expect(status.value).toContain(`--permission-mode ${grokAccessFlags(access).permissionMode}`);
    expect(status.value).toContain(`--sandbox ${grokAccessFlags(access).sandbox}`);
  });
});
