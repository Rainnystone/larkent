import { draftConfirmationDelivery } from '../../../src/automations/draft-confirmation';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannelOptions } from '@larksuite/channel';
import { AutomationsStore } from '../../../src/automations/store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({
  channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined,
  options: undefined as LarkChannelOptions | undefined,
}));
vi.mock('@larksuite/channel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@larksuite/channel')>(),
  createLarkChannel: (opts: LarkChannelOptions) => {
    sdk.options = opts;
    return sdk.channel;
  },
}));
import { startChannel } from '../../../src/bot/channel';
import type { Outage } from '../../../src/bot/feishu-link';

const CHAT = 'oc_group';
const USER = 'ou_user';
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  sdk.channel = undefined;
  sdk.options = undefined;
});

describe('suspend amendment after an early wake frame', () => {
  it('posts the pending confirm card once', async () => {
    let now = NOW;
    const recovered: Outage[] = [];
    let releaseSleep: ((value: { suspended: true; suspendStartedAt: number }) => void) | undefined;
    const h = await startHarness({
      now: () => now,
      onRecovered: (outage) => {
        recovered.push(outage);
      },
      sleepProbe: {
        note() {},
        detect() {
          return new Promise((resolve) => {
            releaseSleep = resolve;
          });
        },
      },
    });
    await h.bridge.recover();
    recovered.length = 0;

    await h.store.saveDraft({
      taskType: 'reminder',
      schedule: { kind: 'one-shot', fireAt: NOW + 60 * 60_000 },
      timezone: 'Asia/Shanghai',
      startAt: NOW,
      endAt: NOW + 60 * 60_000,
      nextFireAt: NOW + 60 * 60_000,
      chatId: CHAT,
      createdBy: USER,
      name: '交周报',
      taskText: '提醒交周报',
    });

    const orig = h.channel.createCard.bind(h.channel);
    let confirmCreates = 0;
    let releaseCreate!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    h.channel.createCard = async (card) => {
      if (JSON.stringify(card).includes('auto.confirm')) {
        confirmCreates += 1;
        if (confirmCreates === 1) await held;
      }
      return orig(card);
    };

    try {
      const reconnects = h.channel.forceReconnectCount;
      now += 5 * 60_000;
      sdk.options?.keepalive?.onWake?.();
      expect(h.channel.forceReconnectCount).toBe(reconnects + 1);
      await yieldIO();
      sdk.options?.keepalive?.onSocketFrame?.();
      expect(recovered).toHaveLength(1);
      expect(recovered[0]!.hostSuspended).toBe(false);
      await until(() => confirmCreates === 1 || h.channel.sent.length > 0);
      if (confirmCreates !== 1) {
        throw new Error(`flush missed creates=${confirmCreates} sent=${h.channel.sent.length} drafts=${h.store.listDrafts().length} card=${draftConfirmationDelivery(h.store.listDrafts()[0]).messageId ?? 'none'}`);
      }

      const gapTick = h.bridge.tickLink();
      await until(() => releaseSleep !== undefined);
      releaseSleep?.({ suspended: true, suspendStartedAt: NOW });
      await gapTick;
      for (let n = 0; n < 30; n++) await yieldIO();

      expect(recovered).toHaveLength(1);
      expect(confirmCreates).toBe(1);
      releaseCreate();
      await until(() => Boolean(draftConfirmationDelivery(h.store.listDrafts()[0]).messageId));
      expect(confirmCards(h.channel)).toHaveLength(1);
      expect(confirmCreates).toBe(1);
    } finally {
      releaseCreate();
    }
  });
});

function confirmCards(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return channel.sent.filter((item) => JSON.stringify(item.content).includes('auto.confirm'));
}

async function until(predicate: () => boolean): Promise<void> {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await yieldIO();
  }
  throw new Error('expected the early-frame card flush');
}

async function startHarness(opts: {
  now: () => number;
  onRecovered: (outage: Outage) => void;
  sleepProbe: {
    note(): void;
    detect(): Promise<{ suspended: true; suspendStartedAt: number }>;
  };
}) {
  const tmp = await createTmpProfile('suspend-amendment-card-');
  const mediaDir = join(tmp.profile, 'media');
  await mkdir(mediaDir, { recursive: true });
  const store = new AutomationsStore({
    path: join(tmp.profile, 'automations.json'),
    logPath: join(tmp.profile, 'automations.log'),
    statusPath: join(tmp.profile, 'automations-status.json'),
    now: opts.now,
  });
  await store.load();
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], allowedChats: [CHAT] },
    preferences: {
      requireMentionInGroup: true,
      messageReply: 'text',
      messageReplyMigrated: true,
      cotMessages: 'off',
    },
  });
  cfg.automations = { enabled: true, agentTasks: false, timezone: 'Asia/Shanghai' };
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }],
    chatMode: 'group',
    botIdentity: { openId: 'ou_bot', name: 'Pin Bot' },
  });
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent: new FakeAgentAdapter({ id: 'claude', events: [] }),
    sessions,
    workspaces,
    automations: store,
    now: opts.now,
    probe: async () => true,
    sleepProbe: opts.sleepProbe,
    onRecovered: opts.onRecovered,
    appPaths: {
      mediaDir,
      secretsFile: join(tmp.profile, 'secrets.enc'),
      keystoreSaltFile: join(tmp.profile, '.keystore.salt'),
    },
    controls: {
      profile: 'test',
      profileConfig: cfg,
      cfg,
      botOwnerId: USER,
      ownerRefreshState: 'ok',
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      processId: 'test-suspend-amendment-card',
    },
  });
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await store.flush().catch(() => {});
    await tmp.cleanup();
  });
  return { channel, store, bridge };
}
