import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultLiveRootDir } from '../../../src/runtime/live-root';
import {
  TestBridgeConfigError,
  loadTestBridgeConfig,
} from '../../../e2e/test-bridge/config';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('test-bridge config loader', () => {
  it('rejects example placeholders so real ids never load from the template', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-config-placeholder-'));
    const path = join(dir, 'test-bridge.json');
    await writeFile(
      path,
      JSON.stringify({
        instance: 't1',
        appId: '<APP_ID>',
        chatId: '<CHAT_ID>',
        testerOpenId: '<OPEN_ID>',
      }),
    );

    await expect(loadTestBridgeConfig(path)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(TestBridgeConfigError);
      expect(String(err)).toMatch(/placeholder/i);
      return true;
    });
  });

  it('rejects a data root that resolves to the live root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-config-live-root-'));
    const path = join(dir, 'test-bridge.json');
    await writeFile(
      path,
      JSON.stringify({
        instance: 't1',
        appId: 'app-placeholder-replaced',
        chatId: 'chat-placeholder-replaced',
        testerOpenId: 'user-placeholder-replaced',
        appSecret: 'secret-placeholder-replaced',
        testerConfigDir: join(dir, 'tester'),
        dataRoot: defaultLiveRootDir(),
      }),
    );
    await mkdir(join(dir, 'tester'), { recursive: true });

    await expect(loadTestBridgeConfig(path)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(TestBridgeConfigError);
      expect(String(err)).toMatch(/live data root/i);
      return true;
    });
  });

  it('accepts an isolated data root and tester config outside that root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-config-ok-'));
    cleanups.push(async () => {
      /* temp json only */
    });
    const testerDir = join(dir, 'tester');
    const dataRoot = join(dir, 'data-root');
    await mkdir(testerDir, { recursive: true });
    const path = join(dir, 'test-bridge.json');
    await writeFile(
      path,
      JSON.stringify({
        instance: 't1',
        profile: 'e2e',
        agentKind: 'cursor',
        tenant: 'feishu',
        appId: 'app-placeholder-replaced',
        appSecret: 'secret-placeholder-replaced',
        chatId: 'chat-placeholder-replaced',
        testerOpenId: 'user-placeholder-replaced',
        allowedUsers: ['user-placeholder-replaced'],
        allowedChats: ['chat-placeholder-replaced'],
        testerConfigDir: testerDir,
        dataRoot,
      }),
    );

    const loaded = await loadTestBridgeConfig(path);
    expect(loaded.instance).toBe('t1');
    expect(loaded.dataRoot).toBe(dataRoot);
    expect(loaded.testerConfigDir).toBe(testerDir);
    expect(loaded.fenceEnabled).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a missing data root whose ancestor symlink points into the live root',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'e2e-config-symlink-'));
      const home = join(dir, 'home');
      const live = join(home, '.lark-channel');
      await mkdir(live, { recursive: true });
      const link = join(dir, 'link-to-live');
      await symlink(live, link);
      const testerDir = join(dir, 'tester');
      await mkdir(testerDir, { recursive: true });
      const path = join(dir, 'test-bridge.json');
      await writeFile(
        path,
        JSON.stringify({
          instance: 't1',
          appId: 'app-placeholder-replaced',
          chatId: 'chat-placeholder-replaced',
          testerOpenId: 'user-placeholder-replaced',
          appSecret: 'secret-placeholder-replaced',
          testerConfigDir: testerDir,
          dataRoot: join(link, 'missing', 'root'),
        }),
      );

      await expect(loadTestBridgeConfig(path, { home })).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(TestBridgeConfigError);
        expect(String(err)).toMatch(/live data root/i);
        return true;
      });
    },
  );
});
