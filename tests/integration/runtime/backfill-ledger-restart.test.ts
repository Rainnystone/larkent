import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

it('reuses one supervisor-owned ledger across controls.restart() so two bridges share one file writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ledger-supervisor-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
  await mkdir(paths.profileDir, { recursive: true });
  const binary = await writeVersionExecutable(root, 'fake-claude', '1.0.0');
  const profile = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_ledger', secret: 'secret', tenant: 'feishu' } },
  });
  profile.agent.binaryPath = binary;
  await saveRootConfig(createRootConfig('test', profile), paths.configFile);

  const seen: StartChannelDeps['ledger'][] = [];
  const supervisor = new Supervisor({
    configPath: paths.configFile,
    rootDir: root,
    runPreflight: false,
    startChannelFn: async (deps) => {
      seen.push(deps.ledger);
      return {
        channel: { botIdentity: { name: 'ledger-bot' } },
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
  expect(paths.backfillStateFile).toBe(join(paths.profileDir, 'backfill-state.json'));
});
