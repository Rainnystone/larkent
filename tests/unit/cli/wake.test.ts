import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readAndPrune: vi.fn(),
  getServiceAdapter: vi.fn(),
  readActiveProfile: vi.fn(),
  loadRootConfig: vi.fn(),
}));

vi.mock('../../../src/runtime/registry', () => ({
  readAndPrune: mocks.readAndPrune,
}));

vi.mock('../../../src/daemon/service-adapter', () => ({
  getServiceAdapter: mocks.getServiceAdapter,
}));

vi.mock('../../../src/config/profile-store', () => ({
  readActiveProfile: mocks.readActiveProfile,
  loadRootConfig: mocks.loadRootConfig,
}));

const { runWake } = await import('../../../src/cli/commands/wake');

const dirs: string[] = [];
const previousHome = process.env.LARK_CHANNEL_HOME;

afterEach(async () => {
  if (previousHome === undefined) delete process.env.LARK_CHANNEL_HOME;
  else process.env.LARK_CHANNEL_HOME = previousHome;
  await Promise.all(dirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
  ));
});

async function withHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-cli-'));
  dirs.push(root);
  process.env.LARK_CHANNEL_HOME = root;
  return root;
}

function adapters(opts: {
  classicFile?: boolean;
  classicRunning?: boolean;
  supervisorFile?: boolean;
  supervisorRunning?: boolean;
}): void {
  mocks.getServiceAdapter.mockImplementation((id: string) => {
    if (id === 'supervisor') {
      return {
        fileExists: () => opts.supervisorFile === true,
        isRunning: () => opts.supervisorRunning === true,
      };
    }
    return {
      fileExists: () => opts.classicFile === true,
      isRunning: () => opts.classicRunning === true,
    };
  });
}

async function wakeFiles(root: string, profile = 'grok'): Promise<string[]> {
  const wakeDir = join(root, 'profiles', profile, 'automations-wake');
  return (await readdir(wakeDir)).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
}

describe('wake CLI', () => {
  it('writes a wake file and starts classic when the profile is stopped', async () => {
    const root = await withHome();
    mocks.readAndPrune.mockReturnValue([]);
    adapters({});
    mocks.readActiveProfile.mockResolvedValue('grok');
    const startIfStopped = vi.fn(async () => {});

    await runWake('3@1792218600000', { startIfStopped });

    expect(await wakeFiles(root)).not.toEqual([]);
    expect(startIfStopped).toHaveBeenCalledWith({ profile: 'grok', skipCheckLarkCli: true });
  });

  it('starts the supervisor service when that is the registered topology', async () => {
    const root = await withHome();
    mocks.readAndPrune.mockReturnValue([]);
    adapters({ supervisorFile: true });
    const startIfStopped = vi.fn(async () => {});

    await runWake('3@1792218600000', { profile: 'grok', startIfStopped });

    expect(await wakeFiles(root)).not.toEqual([]);
    expect(startIfStopped).toHaveBeenCalledWith({
      profile: 'grok',
      skipCheckLarkCli: true,
      webUi: true,
    });
  });

  it('writes a wake file and does not start when the profile is already running', async () => {
    const root = await withHome();
    mocks.readAndPrune.mockReturnValue([{ profileName: 'grok', pid: 42 }]);
    adapters({ classicFile: true, classicRunning: true });
    const startIfStopped = vi.fn(async () => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runWake('3@1792218600000', { profile: 'grok', startIfStopped });
    } finally {
      log.mockRestore();
    }

    expect(await wakeFiles(root)).not.toEqual([]);
    expect(startIfStopped).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('does not bounce a live supervisor when the profile is offline in the console', async () => {
    const root = await withHome();
    mocks.readAndPrune.mockReturnValue([]);
    adapters({ supervisorFile: true, supervisorRunning: true });
    const startIfStopped = vi.fn(async () => {});

    await runWake('3@1792218600000', { profile: 'grok', startIfStopped });

    expect(await wakeFiles(root)).not.toEqual([]);
    expect(startIfStopped).not.toHaveBeenCalled();
  });

  it('rejects an invalid fire key without starting', async () => {
    await withHome();
    const startIfStopped = vi.fn(async () => {});
    await expect(runWake('not-a-key', { profile: 'grok', startIfStopped }))
      .rejects.toThrow(/invalid fire key/);
    expect(startIfStopped).not.toHaveBeenCalled();
  });
});
