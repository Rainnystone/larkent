import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../../src/agent/types';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { log } from '../../../src/core/logger';
import { Supervisor } from '../../../src/runtime/supervisor';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  spawnMock.spawnProcess.mockReset();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('printTimeout snapshot vs /reconnect reload', () => {
  it('keeps the captured adapter after a disk edit until explicit reconnect', async () => {
    const h = await harness('10m');
    spawnMock.spawnProcess.mockReturnValue(fakeChild());
    h.agents[0]!.run({ runId: 'before-edit', prompt: 'hi', cwd: h.workspace });
    expect(printTimeoutArg(0)).toBe('10m');

    h.config.profiles.test!.agent.options = { printTimeout: '30m' };
    await saveRootConfig(h.config, h.paths.configFile);

    spawnMock.spawnProcess.mockClear();
    spawnMock.spawnProcess.mockReturnValue(fakeChild());
    h.agents[0]!.run({ runId: 'after-edit', prompt: 'hi', cwd: h.workspace });
    expect(printTimeoutArg(0)).toBe('10m');
    expect(h.agents).toHaveLength(1);

    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    spawnMock.spawnProcess.mockClear();
    await h.supervisor.restartProfile('test');
    expect(h.agents).toHaveLength(2);

    spawnMock.spawnProcess.mockReturnValue(fakeChild());
    h.agents[1]!.run({ runId: 'after-reconnect', prompt: 'hi', cwd: h.workspace });
    expect(printTimeoutArg(0)).toBe('30m');

    const timing = info.mock.calls.filter((call) => call[0] === 'adapter' && call[1] === 'effective-timing');
    expect(timing.some((call) => {
      const fields = call[2] as { reason?: string; printTimeout?: string };
      return fields.reason === 'created' && fields.printTimeout === '30m';
    })).toBe(true);
  });

  it('does not swap the live adapter when reconnect config is invalid', async () => {
    const h = await harness('10m');
    h.config.profiles.test!.agent.options = { printTimeout: 'nope' };
    await saveRootConfig(h.config, h.paths.configFile);

    await expect(h.supervisor.restartProfile('test')).rejects.toThrow(/printTimeout/);
    expect(h.agents).toHaveLength(1);
    expect(h.supervisor.isOnline('test')).toBe(true);

    spawnMock.spawnProcess.mockReturnValue(fakeChild());
    h.agents[0]!.run({ runId: 'still-old', prompt: 'hi', cwd: h.workspace });
    expect(printTimeoutArg(0)).toBe('10m');
  });
});

async function harness(printTimeout: string): Promise<{
  supervisor: Supervisor;
  config: ReturnType<typeof createRootConfig>;
  paths: ReturnType<typeof resolveAppPaths>;
  agents: AgentAdapter[];
  workspace: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'reconnect-print-timeout-')));
  const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
  const appId = `cli_08_${process.pid}_${Math.random().toString(16).slice(2, 10)}`;
  const profile = createDefaultProfileConfig({
    agentKind: 'antigravity',
    accounts: { app: { id: appId, secret: '${APP_SECRET}', tenant: 'feishu' } },
    options: { printTimeout },
  });
  const config = createRootConfig('test', profile);
  await saveRootConfig(config, paths.configFile);
  const agents: AgentAdapter[] = [];
  const supervisor = new Supervisor({
    configPath: paths.configFile,
    rootDir: root,
    runPreflight: false,
    startChannelFn: async (deps) => {
      agents.push(deps.agent);
      return { channel: { botIdentity: { name: 'bot-test' } }, disconnect: async () => {} } as never;
    },
  });
  cleanups.push(async () => {
    await supervisor.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await supervisor.startProfile('test');
  return { supervisor, config, paths, agents, workspace: tmpdir() };
}

function printTimeoutArg(call: number): string | undefined {
  const argv = spawnMock.spawnProcess.mock.calls[call]?.[1] as string[] | undefined;
  if (!argv) return undefined;
  const flag = argv.indexOf('--print-timeout');
  return flag === -1 ? undefined : argv[flag + 1];
}

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = 0;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}
