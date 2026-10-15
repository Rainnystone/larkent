import { mkdir, mkdtemp, realpath, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { machineAppLockFile, RuntimeLockConflictError } from '../../../src/runtime/locks';
import { Supervisor } from '../../../src/runtime/supervisor';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('machine-level app lock across data roots', () => {
  it('refuses a second start of the same app id from another data root', async () => {
    const appId = 'cli_fake_shared_app_0a';
    const first = await harness('first', appId);
    const second = await harness('second', appId);
    await first.supervisor.startProfile('test');

    await expect(second.supervisor.startProfile('test')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(RuntimeLockConflictError);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(appId);
      return true;
    });

    await first.supervisor.shutdown();
    const staleLockfile = `${machineAppLockFile(appId)}.lock`;
    await mkdir(staleLockfile, { recursive: true });
    const past = new Date(Date.now() - 60_000);
    await utimes(staleLockfile, past, past);
    await second.supervisor.startProfile('test');
    expect(second.supervisor.isOnline('test')).toBe(true);
  });
});

async function harness(label: string, appId: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `machine-app-lock-${label}-`)));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json');
  const profile = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: appId, secret: 'fake-secret', tenant: 'feishu' } },
  });
  await saveRootConfig(createRootConfig('test', profile), configPath);
  const supervisor = new Supervisor({
    configPath,
    rootDir: root,
    runPreflight: false,
    startChannelFn: async () =>
      ({ channel: { botIdentity: { name: 'fake' } }, disconnect: async () => {} }) as never,
  });
  cleanups.push(() => supervisor.shutdown());
  return { supervisor, root };
}
