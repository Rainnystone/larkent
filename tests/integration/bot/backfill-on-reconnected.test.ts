import { setImmediate as yieldIO } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { BackfillLedger } from '../../../src/bot/backfill-ledger';
import * as logger from '../../../src/core/logger';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const sdk = vi.hoisted(() => ({
  channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined,
}));
vi.mock('@larksuite/channel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@larksuite/channel')>(),
  createLarkChannel: () => sdk.channel,
}));
import { startChannel } from '../../../src/bot/channel';

const BOT = 'ou_bot';
const USER = 'ou_user';
const CHAT = 'oc_group';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('backfill on SDK reconnected', () => {
  it('scans on reconnected after a real gap and logs trigger reconnected', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await startHarness({ lastLiveAt: Date.now() - 1_000 });
    await settle();
    const listedAfterConnect = h.channel.listChatsCalls;
    await rewindWatermark(h, 5 * 60_000);
    const created = Date.now() - 90_000;
    h.setMessages({
      [CHAT]: [mentionItem('om_blip', CHAT, 'missed during blip', created)],
    });
    h.channel.emit('reconnecting');
    h.channel.emit('reconnected');
    await waitFor(() => h.ledger.getLastBackfillEnd() !== undefined);
    await waitForDebounce();
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(events(info, 'ws')).toContainEqual(expect.objectContaining({ event: 'reconnected' }));
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({
        event: 'trigger',
        trigger: 'reconnected',
        gapMs: expect.any(Number),
        windowStart: expect.any(Number),
        windowEnd: expect.any(Number),
      }),
    );
    expect(h.agent.runOptions[0]!.prompt).toContain('missed during blip');
    expect(h.channel.listChatsCalls).toBe(listedAfterConnect + 1);
  });

  it('skips a short-gap reconnected without listing chats', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await startHarness({ lastLiveAt: Date.now() - 1_000 });
    await settle();
    const listedAfterConnect = h.channel.listChatsCalls;
    h.channel.emit('reconnected');
    await settle();
    expect(h.channel.listChatsCalls).toBe(listedAfterConnect);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'skip-short-gap' }),
    );
  });

  it('ten reconnecteds after one 5 min gap produce one scan and nine coalesce or skip-short-gap lines', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const h = await startHarness({ lastLiveAt: Date.now() - 1_000 });
    await settle();
    const baseline = h.channel.listChatsCalls;
    info.mockClear();
    const listHold = holdNext(h.channel, 'listChats');
    await rewindWatermark(h, 5 * 60_000);
    for (let n = 0; n < 10; n++) {
      h.channel.emit('reconnecting');
      h.channel.emit('reconnected');
    }
    expect(listHold.started).toBe(1);
    const storm = events(info, 'backfill').filter((row) => (
      row.event === 'coalesced' || row.event === 'skip-short-gap' || row.event === 'trigger'
    ));
    expect(storm.filter((row) => row.event === 'trigger')).toHaveLength(1);
    expect(storm.filter((row) => row.event === 'trigger')[0]).toEqual(
      expect.objectContaining({ trigger: 'reconnected' }),
    );
    expect(storm.filter((row) => row.event === 'coalesced' || row.event === 'skip-short-gap')).toHaveLength(9);
    listHold.release();
    await waitFor(() => events(info, 'backfill').some((row) => row.event === 'done'));
    expect(h.channel.listChatsCalls).toBe(baseline + 1);
    expect(events(info, 'backfill').filter((row) => row.event === 'trigger')).toHaveLength(1);
  });

  it('B2: late WS after reconnected backfill loses the claim with source ws', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const created = Date.now() - 90_000;
    const h = await startHarness({ lastLiveAt: Date.now() - 1_000 });
    await settle();
    await rewindWatermark(h, 5 * 60_000);
    h.setMessages({
      [CHAT]: [mentionItem('om_race_ws', CHAT, 'late blip', created, 'omt_race')],
    });
    h.channel.emit('reconnected');
    await waitFor(() => h.ledger.has('om_race_ws'));
    await h.channel.handlers.message?.(liveMention('om_race_ws', 'late blip', created, 'omt_race'));
    await waitForDebounce();
    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions).toHaveLength(1);
    expect(intakeDuplicates(info)).toEqual([
      { event: 'skip-duplicate', msgId: 'om_race_ws', scope: `${CHAT}:omt_race`, source: 'ws' },
    ]);
  });

  it('B2: live WS then reconnected backfill loses the claim with source backfill', async () => {
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});
    const created = Date.now() - 90_000;
    const h = await startHarness({ lastLiveAt: Date.now() - 1_000 });
    await settle();
    await rewindWatermark(h, 5 * 60_000);
    h.setMessages({
      [CHAT]: [mentionItem('om_race_bf', CHAT, 'live first', created, 'omt_race')],
    });
    const modeHold = holdNext(h.channel, 'getChatMode');
    const live = h.channel.handlers.message?.(liveMention('om_race_bf', 'live first', created, 'omt_race'));
    await settle();
    h.channel.emit('reconnected');
    await waitFor(() => intakeDuplicates(info).some((row) => row.source === 'backfill'));
    modeHold.release();
    await live;
    await waitForDebounce();
    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions).toHaveLength(1);
    expect(intakeDuplicates(info)).toEqual([
      { event: 'skip-duplicate', msgId: 'om_race_bf', scope: `${CHAT}:omt_race`, source: 'backfill' },
    ]);
  });
});

async function startHarness(opts: {
  lastLiveAt: number;
}) {
  const tmp = await createTmpProfile('backfill-reconnected-');
  const file = `${tmp.profile}/backfill-state.json`;
  const ledger = new BackfillLedger(file);
  await ledger.load();
  ledger.touchLive(opts.lastLiveAt);
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], admins: [USER] },
    preferences: {
      messageReply: 'text',
      cotMessages: 'off',
      requireMentionInGroup: true,
    },
  });
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const agent = new FakeAgentAdapter({
    id: 'claude',
    events: [
      { type: 'text', delta: 'late answer' },
      { type: 'done', terminationReason: 'normal' },
    ],
  });
  const messagesByChat: Record<string, unknown[]> = {};
  const channel = createRecordingLarkChannel({
    botIdentity: { openId: BOT, name: 'Bot' },
    chats: [{ id: CHAT, name: 'Group' }],
    messagesByChat,
  });
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    ledger,
    controls: {
      profile: 'test',
      profileConfig: cfg,
      cfg,
      ownerRefreshState: 'ok',
      botOwnerId: USER,
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: `${tmp.root}/config.json`,
      processId: 'test-backfill-reconnected',
    },
  });
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await tmp.cleanup();
  });
  return {
    channel,
    agent,
    ledger,
    setMessages(next: Record<string, unknown[]>) {
      for (const key of Object.keys(messagesByChat)) delete messagesByChat[key];
      Object.assign(messagesByChat, next);
    },
  };
}

function rewindWatermark(h: { ledger: BackfillLedger }, gapMs: number) {
  h.ledger.touchLive(Date.now() - gapMs);
}

function holdNext<K extends 'listChats' | 'getChatMode'>(
  channel: ReturnType<typeof createRecordingLarkChannel>,
  method: K,
): { started: number; release: () => void } {
  let release = (): void => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const orig = channel[method].bind(channel) as (...args: unknown[]) => Promise<unknown>;
  const state = { started: 0, release };
  channel[method] = (async (...args: unknown[]) => {
    state.started += 1;
    await hold;
    return orig(...args);
  }) as typeof channel[K];
  cleanups.push(async () => {
    state.release();
  });
  return state;
}

function mentionItem(
  messageId: string,
  chatId: string,
  text: string,
  createTime: number,
  threadId?: string,
): Record<string, unknown> {
  return {
    message_id: messageId,
    chat_id: chatId,
    msg_type: 'text',
    create_time: String(createTime),
    deleted: false,
    sender: { id: USER, id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: `@_user_1 ${text}` }) },
    mentions: [{ key: '@_user_1', id: BOT, id_type: 'open_id', name: 'Bot' }],
    ...(threadId ? { thread_id: threadId } : {}),
  };
}

function liveMention(
  messageId: string,
  content: string,
  createTime: number,
  threadId?: string,
): NormalizedMessage {
  return {
    messageId,
    content,
    chatId: CHAT,
    chatType: 'group',
    senderId: USER,
    senderName: 'User',
    rawContentType: 'text',
    resources: [],
    mentionedBot: true,
    createTime,
    ...(threadId ? { threadId } : {}),
  } as NormalizedMessage;
}

function events(
  spy: { mock: { calls: unknown[][] } },
  phase: string,
): Array<{ event: string } & Record<string, unknown>> {
  return spy.mock.calls
    .filter((call) => call[0] === phase)
    .map((call) => ({ event: String(call[1]), ...(isRecord(call[2]) ? call[2] : {}) }));
}

function intakeDuplicates(info: { mock: { calls: unknown[][] } }) {
  return events(info, 'intake').filter((row) => row.event === 'skip-duplicate').map((row) => ({
    event: row.event,
    msgId: row.msgId,
    scope: row.scope,
    source: row.source,
  }));
}

async function waitForDebounce() {
  await new Promise((resolve) => setTimeout(resolve, 700));
}

async function settle() {
  for (let n = 0; n < 20; n++) await yieldIO();
}

async function waitFor(predicate: () => boolean) {
  for (let n = 0; n < 10_000; n++) {
    if (predicate()) return;
    await yieldIO();
  }
  throw new Error('expected backfill transition was not observed');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
