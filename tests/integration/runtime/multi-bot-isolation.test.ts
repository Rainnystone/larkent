import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { Supervisor } from '../../../src/runtime/supervisor.js';
import { readAndPrune } from '../../../src/runtime/registry.js';
import { resolveAppPaths } from '../../../src/config/app-paths.js';
import { createRecordingLarkChannel, type RecordingLarkChannel } from '../../helpers/recording-lark-channel.js';
import { installKindCli, withEnvBin, withPathPrefix } from '../../helpers/scripted-jsonl-cli.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channels: new Map<string, RecordingLarkChannel>(),
  createLarkChannel: vi.fn((opts: { appId: string }) => {
    const existing = sdkMock.channels.get(opts.appId);
    if (existing) return existing;
    const channel = createRecordingLarkChannel();
    sdkMock.channels.set(opts.appId, channel);
    return channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  sdkMock.channels.clear();
  sdkMock.createLarkChannel.mockClear();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe('P6 multi-bot isolation', () => {
  it('keeps a mention in bot A from reaching bot B and isolates sessions, locks, and registry rows', async () => {
    const tmp = await createTmpProfile('multi-bot-isolation-');
    cleanups.push(tmp.cleanup);
    const binDir = join(tmp.root, 'bin');
    const kimi = await installKindCli(binDir, 'kimi');
    const grok = await installKindCli(binDir, 'grok');
    const previousAppSecret = process.env.APP_SECRET;
    process.env.APP_SECRET = 'pin-secret';

    const kimiWorkspace = join(tmp.root, 'ws-kimi');
    const grokWorkspace = join(tmp.root, 'ws-grok');
    await mkdir(kimiWorkspace, { recursive: true });
    await mkdir(grokWorkspace, { recursive: true });
    await mkdir(join(tmp.root, 'profiles', 'kimi-bot'), { recursive: true });
    await mkdir(join(tmp.root, 'profiles', 'grok-bot'), { recursive: true });

    const kimiProfile = createDefaultProfileConfig({
      agentKind: 'kimi',
      accounts: { app: { id: 'cli_bot_a', secret: '${APP_SECRET}', tenant: 'feishu' } },
      access: { allowedUsers: ['ou_user'] },
    });
    kimiProfile.workspaces.default = kimiWorkspace;
    const grokProfile = createDefaultProfileConfig({
      agentKind: 'grok',
      accounts: { app: { id: 'cli_bot_b', secret: '${APP_SECRET}', tenant: 'feishu' } },
      access: { allowedUsers: ['ou_user'] },
    });
    grokProfile.workspaces.default = grokWorkspace;

    const configPath = join(tmp.root, 'config.json');
    const root = createRootConfig('kimi-bot', kimiProfile);
    root.profiles['grok-bot'] = grokProfile;
    await saveRootConfig(root, configPath);

    const sup = new Supervisor({
      configPath,
      rootDir: tmp.root,
      runPreflight: false,
      startChannelFn: startChannel,
    });
    cleanups.push(() => sup.shutdown());

    try {
      await withEnvBin('kimi', kimi.fake.path, async () => {
        await withEnvBin('grok', grok.fake.path, async () => {
          await withPathPrefix(binDir, async () => {
            await sup.startProfile('kimi-bot');
            await sup.startProfile('grok-bot');

            const channelA = sdkMock.channels.get('cli_bot_a');
            const channelB = sdkMock.channels.get('cli_bot_b');
            expect(channelA).toBeDefined();
            expect(channelB).toBeDefined();

            await channelA!.handlers.message?.(mention('om_a', 'oc_a', 'hello from A'));
            await waitFor(async () => fileExists(kimi.fake.recordPath), 10_000);

            expect(await fileExists(grok.fake.recordPath)).toBe(false);
            expect(channelB!.callLog.filter((call) => call.op === 'send' || call.op === 'stream')).toEqual([]);

            const kimiPaths = resolveAppPaths({ rootDir: tmp.root, profile: 'kimi-bot' });
            const grokPaths = resolveAppPaths({ rootDir: tmp.root, profile: 'grok-bot' });
            expect(kimiPaths.sessionsFile).not.toBe(grokPaths.sessionsFile);
            expect(kimiPaths.profileLockFile).not.toBe(grokPaths.profileLockFile);
            await expect(access(kimiPaths.profileLockFile)).resolves.toBeUndefined();
            await expect(access(grokPaths.profileLockFile)).resolves.toBeUndefined();

            const registry = readAndPrune(kimiPaths.userRegistryFile);
            expect(registry.map((entry) => entry.profileName).sort()).toEqual(['grok-bot', 'kimi-bot']);
            expect(registry.map((entry) => entry.agentKind).sort()).toEqual(['grok', 'kimi']);
            expect(new Set(registry.map((entry) => entry.appId))).toEqual(new Set(['cli_bot_a', 'cli_bot_b']));
          });
        });
      });
    } finally {
      if (previousAppSecret === undefined) delete process.env.APP_SECRET;
      else process.env.APP_SECRET = previousAppSecret;
    }
  }, 30_000);
});

function mention(messageId: string, chatId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId,
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: true,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for isolation predicate');
}
