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

it('reuses one supervisor-owned turn journal across controls.restart()', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-supervisor-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
  await mkdir(paths.profileDir, { recursive: true });
  const binary = await writeVersionExecutable(root, 'fake-claude', '1.0.0');
  const profile = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_journal', secret: 'secret', tenant: 'feishu' } },
  });
  profile.agent.binaryPath = binary;
  await saveRootConfig(createRootConfig('test', profile), paths.configFile);

  const seen: StartChannelDeps['journal'][] = [];
  const supervisor = new Supervisor({
    configPath: paths.configFile,
    rootDir: root,
    runPreflight: false,
    startChannelFn: async (deps) => {
      seen.push(deps.journal);
      return {
        channel: { botIdentity: { name: 'journal-bot' } },
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
  expect(paths.turnJournalFile).toBe(join(paths.profileDir, 'turn-journal.json'));
});
