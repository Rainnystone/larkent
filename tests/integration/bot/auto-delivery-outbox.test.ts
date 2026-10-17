import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CATCH_UP_WINDOW_MS,
  formatFireKey,
  type Schedule,
} from '../../../src/automations/schedule';
import { AutomationsStore } from '../../../src/automations/store';
import { FEISHU_DELIVERY_ID_MAX_CHARS, TurnJournal } from '../../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { axiosErrno, sdkShapedSendError } from '../../helpers/sdk-feishu-errors';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({
  channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined,
}));
vi.mock('@larksuite/channel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@larksuite/channel')>(),
  createLarkChannel: () => sdk.channel,
}));
import { startChannel } from '../../../src/bot/channel';

const CHAT = 'oc_group';
const USER = 'ou_user';
const HOUR = 60 * 60_000;
const t0 = Date.UTC(2026, 0, 2, 12, 0, 0);

const HOURLY_END = t0 + 365 * 24 * HOUR;
const hourly: Extract<Schedule, { kind: 'interval' }> = {
  kind: 'interval',
  timezone: 'UTC',
  everyMs: HOUR,
  startAt: t0,
  endAt: HOURLY_END,
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  sdk.channel = undefined;
});

describe('automation reminder delivery via Outbox', { timeout: 20_000 }, () => {
  it('posts exactly one reminder text when the fake clock reaches the instant', async () => {
    const h = await harness({ nowMs: t0, seed: true });

    await waitFor(async () => {
      if (reminderBodies(h.channel).length !== 1) return false;
      try {
        const status = await readStatus(h.statusPath);
        return status.items[0]?.lastStatus === 'ok' && status.items[0]?.lastFireAt === t0;
      } catch {
        return false;
      }
    });

    expect(reminderBodies(h.channel)).toEqual(['⏰ hourly ping：ping']);
    expect(outboxSends(h.channel)).toHaveLength(1);
    expect(replyToOf(outboxSends(h.channel)[0])).toBeUndefined();
    expect(continuationBodies(h.channel)).toEqual([]);
    expect(await readStatus(h.statusPath)).toEqual({
      v: 1,
      bot: 'Pin Bot',
      updatedAt: t0,
      items: [{
        id: 1,
        paused: false,
        nextFireAt: t0 + HOUR,
        lastFireAt: t0,
        lastStatus: 'ok',
        endAt: HOURLY_END,
        missed: 0,
      }],
    });
    await expect(h.store.readLog()).resolves.toEqual([]);
  });

  it('keeps a link-error send staged, then delivers once after recovery without a catch-up duplicate', async () => {
    const h = await harness({ nowMs: t0, seed: true, send: failingLinkSend() });

    await waitFor(() => h.journal.list().some((entry) => (
      entry.turnId.startsWith('af:') && entry.reply?.state === 'staged'
    )));
    expect(reminderBodies(h.channel)).toEqual([]);
    expect(h.store.hasStarted(formatFireKey(1, t0))).toBe(true);

    h.releaseSend();
    await h.bridge.tickLink();
    await waitFor(() => reminderBodies(h.channel).length === 1);

    expect(reminderBodies(h.channel)).toEqual(['⏰ hourly ping：ping']);
    expect(outboxSends(h.channel)).toHaveLength(1);
    expect(h.journal.list().some((entry) => (
      entry.turnId.startsWith('af:') && entry.reply?.state === 'sent'
    ))).toBe(true);
    expect(await h.store.readLog()).toEqual([]);
  });

  it('stages nothing while the link is down at the instant, then catch-up once within 24 h', async () => {
    const h = await harness({ nowMs: t0, seed: true, linkDown: true });
    await h.bridge.tickLink();

    expect(h.journal.list()).toEqual([]);
    expect(outboxSends(h.channel)).toEqual([]);
    expect(reminderBodies(h.channel)).toEqual([]);
    expect(h.store.hasStarted(formatFireKey(1, t0))).toBe(false);
    expect(h.store.get(1)?.nextFireAt).toBe(t0);

    h.setNow(t0 + 60_000);
    h.channel.connectionState = 'connected';
    await h.bridge.tickLink();
    await waitFor(async () => {
      if (reminderBodies(h.channel).length !== 1) return false;
      try {
        const status = await readStatus(h.statusPath);
        return status.items[0]?.lastStatus === 'ok' && status.items[0]?.lastFireAt === t0;
      } catch {
        return false;
      }
    });

    expect(reminderBodies(h.channel)).toEqual(['⏰ hourly ping：ping（补跑，原定 12:00）']);
    expect(outboxSends(h.channel)).toHaveLength(1);
    expect(continuationBodies(h.channel)).toEqual([]);
    expect(await h.store.readLog()).toEqual([
      expect.objectContaining({
        id: 1,
        scheduledAt: t0,
        triggerSource: 'link-recovered',
        result: 'catch-up',
      }),
    ]);
    expect(await readStatus(h.statusPath)).toMatchObject({
      v: 1,
      items: [expect.objectContaining({
        id: 1,
        lastFireAt: t0,
        lastStatus: 'ok',
        missed: 0,
      })],
    });
  });

  it('after > 24 h down posts no catch-up, one missed notice, missed +1, and one log entry', async () => {
    const h = await harness({
      nowMs: t0,
      seed: reminderInput({
        schedule: { kind: 'one-shot', fireAt: t0 },
        startAt: t0 - 20 * 60_000,
        endAt: t0,
        name: 'hourly ping',
      }),
      linkDown: true,
    });
    await h.bridge.tickLink();
    expect(outboxSends(h.channel)).toEqual([]);
    expect(h.journal.list()).toEqual([]);

    h.setNow(t0 + CATCH_UP_WINDOW_MS + 1);
    h.channel.connectionState = 'connected';
    await h.bridge.tickLink();
    await waitFor(async () => {
      if (missedBodies(h.channel).length !== 1) return false;
      try {
        const status = await readStatus(h.statusPath);
        return status.items[0]?.lastStatus === 'missed' && status.items[0]?.missed === 1;
      } catch {
        return false;
      }
    });

    expect(reminderBodies(h.channel)).toEqual([]);
    expect(missedBodies(h.channel)).toEqual(['已错过：hourly ping\n原定 12:00']);
    expect(outboxSends(h.channel)).toHaveLength(1);
    expect(h.store.get(1)?.missed).toBe(1);
    expect(h.store.hasStarted(formatFireKey(1, t0))).toBe(false);
    expect(await h.store.readLog()).toEqual([
      expect.objectContaining({
        id: 1,
        scheduledAt: t0,
        triggerSource: 'link-recovered',
        result: 'missed',
      }),
    ]);
    expect(await readStatus(h.statusPath)).toMatchObject({
      v: 1,
      items: [expect.objectContaining({
        id: 1,
        lastStatus: 'missed',
        missed: 1,
        lastFireAt: 0,
      })],
    });
  });

  it('holds exactly one chat message after kill/restart around a fire', async () => {
    const first = await harness({ nowMs: t0, seed: true, send: failingLinkSend() });
    await waitFor(() => first.journal.list().some((entry) => (
      entry.turnId.startsWith('af:') && entry.reply?.state === 'staged'
    )));
    expect(outboxSends(first.channel)).toEqual([]);
    expect(reminderBodies(first.channel)).toEqual([]);
    await first.journal.flush();
    await first.store.flush();
    await first.bridge.disconnect();

    const restarted = await harness({
      nowMs: t0,
      tmp: first.tmp,
      store: first.store,
      reuseCleanup: true,
    });
    await waitFor(() => reminderBodies(restarted.channel).length === 1);

    expect(reminderBodies(restarted.channel)).toEqual(['⏰ hourly ping：ping']);
    expect(outboxSends(restarted.channel)).toHaveLength(1);
    expect(continuationBodies(restarted.channel)).toEqual([]);
  });

  it('derives a deliveryId ≤ 50 chars that is unique per fire and unclipped for a long fire key', async () => {
    const h = await harness({
      nowMs: t0,
      seed: [
        reminderInput({ name: 'one', taskText: 'a' }),
        reminderInput({ name: 'two', taskText: 'b' }),
      ],
    });
    await waitFor(() => reminderBodies(h.channel).length === 2);

    const ids = deliveryIds(h.channel);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id.length).toBeLessThanOrEqual(FEISHU_DELIVERY_ID_MAX_CHARS);
      expect(id.startsWith('reply:af:')).toBe(true);
      expect(id).toBe(id.slice(0, FEISHU_DELIVERY_ID_MAX_CHARS));
    }

    const longKey = formatFireKey(Number.MAX_SAFE_INTEGER, Date.UTC(2099, 11, 31, 23, 59));
    const longId = `reply:af:${longKey}`;
    expect(longId.length).toBeLessThanOrEqual(FEISHU_DELIVERY_ID_MAX_CHARS);
    expect(longId).not.toBe(ids[0]);
  });
});

type Recording = ReturnType<typeof createRecordingLarkChannel>;

async function harness(opts: {
  nowMs: number;
  seed?: boolean | ReturnType<typeof reminderInput> | Array<ReturnType<typeof reminderInput>>;
  linkDown?: boolean;
  send?: (orig: Recording['send']) => Recording['send'];
  tmp?: Awaited<ReturnType<typeof createTmpProfile>>;
  store?: AutomationsStore;
  reuseCleanup?: boolean;
} = { nowMs: t0 }) {
  const tmp = opts.tmp ?? await createTmpProfile('auto-outbox-');
  let nowMs = opts.nowMs;
  const now = () => nowMs;
  const store = opts.store ?? new AutomationsStore({
    path: join(tmp.profile, 'automations.json'),
    logPath: join(tmp.profile, 'automations.log'),
    statusPath: join(tmp.profile, 'automations-status.json'),
    now,
  });
  if (!opts.store) await store.load();
  const seeds = opts.seed === true
    ? [reminderInput()]
    : Array.isArray(opts.seed)
      ? opts.seed
      : opts.seed
        ? [opts.seed]
        : [];
  for (const item of seeds) await store.create(item);

  const journal = new TurnJournal(join(tmp.profile, 'turn-journal.json'), { now });
  await journal.load();
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], allowedChats: [CHAT] },
    preferences: {
      requireMentionInGroup: true,
      messageReply: 'text',
      messageReplyMigrated: true,
    },
  });
  cfg.automations = { enabled: true, agentTasks: false, timezone: 'UTC' };
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd(CHAT, tmp.workspace);
  const agent = new FakeAgentAdapter({ id: 'claude' });
  const channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }],
    chatMode: 'group',
    botIdentity: { openId: 'ou_bot', name: 'Pin Bot' },
  });
  if (opts.linkDown) channel.connectionState = 'reconnecting';
  const origSend = channel.send.bind(channel);
  let releaseSend: () => void = () => {};
  if (opts.send) {
    channel.send = opts.send(origSend);
    releaseSend = () => {
      channel.send = origSend;
    };
  }
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    automations: store,
    journal,
    now,
    probe: async () => true,
    controls: {
      profile: 'test',
      profileConfig: cfg,
      cfg,
      botOwnerId: 'ou_owner',
      ownerRefreshState: 'ok',
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      processId: 'test-auto-outbox',
    },
  });
  const cleanup = async () => {
    await bridge.disconnect().catch(() => {});
    await store.flush().catch(() => {});
    await journal.flush().catch(() => {});
    if (!opts.reuseCleanup) await tmp.cleanup();
  };
  cleanups.push(cleanup);
  return {
    channel,
    store,
    journal,
    bridge,
    tmp,
    statusPath: join(tmp.profile, 'automations-status.json'),
    setNow(next: number) {
      nowMs = next;
    },
    releaseSend,
  };
}

function reminderInput(overrides: Partial<Parameters<AutomationsStore['create']>[0]> = {}) {
  return {
    taskType: 'reminder' as const,
    schedule: hourly,
    timezone: 'UTC',
    startAt: t0,
    endAt: HOURLY_END,
    nextFireAt: t0,
    chatId: CHAT,
    createdBy: USER,
    name: 'hourly ping',
    taskText: 'ping',
    ...overrides,
  };
}

function failingLinkSend() {
  return (_orig: Recording['send']): Recording['send'] => {
    return async () => {
      throw sdkShapedSendError(
        'unknown',
        axiosErrno('ENETUNREACH', 'connect ENETUNREACH 1.2.3.4:443'),
      );
    };
  };
}

function bodies(channel: Recording): string[] {
  return channel.sent.map((row) => {
    const content = row.content as { text?: string; markdown?: string };
    if (typeof content?.text === 'string') return content.text;
    if (typeof content?.markdown === 'string') return content.markdown;
    return JSON.stringify(row.content);
  });
}

function isBoardSend(row: Recording['sent'][number]): boolean {
  return JSON.stringify(row.content).includes('本群自动化');
}

function outboxSends(channel: Recording): Recording['sent'] {
  return channel.sent.filter((row) => !isBoardSend(row));
}

function reminderBodies(channel: Recording): string[] {
  return bodies(channel).filter((body) => body.startsWith('⏰'));
}

function missedBodies(channel: Recording): string[] {
  return bodies(channel).filter((body) => body.startsWith('已错过：'));
}

function continuationBodies(channel: Recording): string[] {
  return bodies(channel).filter((body) => body.includes('继续') || body.includes('notice.continue'));
}

function replyToOf(row: Recording['sent'][number] | undefined): string | undefined {
  const options = row?.options as { replyTo?: string } | undefined;
  const replyTo = options?.replyTo;
  return typeof replyTo === 'string' && replyTo ? replyTo : undefined;
}

function deliveryIds(channel: Recording): string[] {
  return outboxSends(channel).map((row) => {
    const uuid = (row.options as { uuid?: string } | undefined)?.uuid;
    return typeof uuid === 'string' ? uuid : '';
  }).filter((id) => id.startsWith('reply:af:') || id.startsWith('reply:am:'));
}

async function readStatus(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as {
    v: number;
    bot: string;
    updatedAt: number;
    items: Array<{
      id: number;
      paused: boolean;
      nextFireAt: number;
      lastFireAt: number;
      lastStatus: string;
      endAt: number;
      missed: number;
    }>;
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await yieldIO();
  }
  throw new Error('expected automation outbox transition was not observed');
}
