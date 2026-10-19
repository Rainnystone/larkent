import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { StartChannelDeps } from '../../../src/bot/channel';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { Supervisor } from '../../../src/runtime/supervisor';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function missing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

it('does not create automations files when the flag is off and reuses the supervisor-owned store across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'automations-supervisor-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
  await mkdir(paths.profileDir, { recursive: true });
  const binary = await writeVersionExecutable(root, 'fake-claude', '1.0.0');
  const profile = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_auto', secret: 'secret', tenant: 'feishu' } },
  });
  profile.agent.binaryPath = binary;
  expect(profile.automations.enabled).toBe(false);
  await saveRootConfig(createRootConfig('test', profile), paths.configFile);

  const seen: StartChannelDeps['automations'][] = [];
  const supervisor = new Supervisor({
    configPath: paths.configFile,
    rootDir: root,
    runPreflight: false,
    startChannelFn: async (deps) => {
      seen.push(deps.automations);
      return {
        channel: { botIdentity: { name: 'auto-bot' } },
        disconnect: async () => {},
      } as never;
    },
  });
  cleanups.push(() => supervisor.shutdown());

  await supervisor.startProfile('test');
  await supervisor.restartProfile('test');

  expect(seen).toHaveLength(2);
  expect(seen[0]).toBe(seen[1]);
  expect(seen[0]).toBeDefined();
  expect(paths.automationsFile).toBe(join(paths.profileDir, 'automations.json'));
  expect(paths.automationsLogFile).toBe(join(paths.profileDir, 'automations.log'));
  expect(paths.automationsStatusFile).toBe(join(paths.profileDir, 'automations-status.json'));
  expect(paths.automationsWakeDir).toBe(join(paths.profileDir, 'automations-wake'));
  expect(await missing(paths.automationsFile)).toBe(true);
  expect(await missing(paths.automationsLogFile)).toBe(true);
  expect(await missing(paths.automationsStatusFile)).toBe(true);
});
