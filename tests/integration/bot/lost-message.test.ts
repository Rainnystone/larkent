import { join } from 'node:path';
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

const CHAT = 'oc_group';
const BOT = 'ou_bot';
const USER = 'ou_user';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('lost-message recovery', { timeout: 20_000 }, () => {
  it('recovers two queued messages after /reconnect with one lateness hint each', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const history: Record<string, unknown[]> = { [CHAT]: [] };
    const h = await harness({ hold, history });
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});

    await h.channel.handlers.message?.(mention('om_run', 'start the run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 1);

    const first = mention('om_one', 'first queued');
    const second = mention('om_two', 'second queued');
    await h.channel.handlers.message?.(first);
    await h.channel.handlers.message?.(second);
    history[CHAT] = [
      mentionHistory('om_one', first.content, first.createTime),
      mentionHistory('om_two', second.content, second.createTime),
    ];

    await h.channel.handlers.message?.(mention('om_reconnect', '/reconnect'));
    await waitFor(() => {
      const prompts = h.agent.runOptions.map((opts) => opts.prompt).join('\n');
      return prompts.includes('first queued') && prompts.includes('second queued');
    });
    const recovered = h.agent.runOptions.filter((opts) => (
      opts.prompt.includes('first queued') || opts.prompt.includes('second queued')
    ));
    expect(recovered.length).toBeGreaterThan(0);
    expect(recovered.every((opts) => opts.prompt.includes('bridge 重连后才补处理'))).toBe(true);
    expect(recovered.filter((opts) => opts.prompt.includes('first queued'))).toHaveLength(1);
    expect(recovered.filter((opts) => opts.prompt.includes('second queued'))).toHaveLength(1);
    expect(info.mock.calls.some((call) => call[0] === 'pending' && call[1] === 'handoff')).toBe(true);
    release();
  });

  it('handoffs pending across keepalive restart and keeps a closing-window event', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const history: Record<string, unknown[]> = { [CHAT]: [] };
    const h = await harness({ hold, history });
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});

    await h.channel.handlers.message?.(mention('om_run', 'start the run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 1);

    const queued = mention('om_queued', 'queued during run');
    await h.channel.handlers.message?.(queued);
    const late = mention('om_closing', 'arrived while closing');
    history[CHAT] = [
      mentionHistory('om_queued', queued.content, queued.createTime),
      mentionHistory('om_closing', late.content, late.createTime),
    ];

    const oldChannel = h.channel;
    const oldBridge = h.bridge;
    await oldBridge.disconnect();
    await oldChannel.handlers.message?.(late);
    expect(h.ledger.has('om_queued')).toBe(false);
    expect(h.ledger.getIncompleteFrom()).toBeDefined();

    sdk.channel = createRecordingLarkChannel({
      chats: [{ id: CHAT, name: 'G' }],
      messagesByChat: history,
    });
    const next = await startChannel({
      cfg: h.cfg,
      agent: h.agent,
      sessions: h.sessions,
      workspaces: h.workspaces,
      ledger: h.ledger,
      controls: h.makeControls(),
    });
    cleanups.push(async () => { await next.disconnect().catch(() => {}); });
    await next.recoverMissed();
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => {
      const prompts = h.agent.runOptions.map((opts) => opts.prompt).join('\n');
      return prompts.includes('queued during run') && prompts.includes('arrived while closing');
    });
    const recovered = h.agent.runOptions.filter((opts) => (
      opts.prompt.includes('queued during run') || opts.prompt.includes('arrived while closing')
    ));
    expect(recovered.every((opts) => opts.prompt.includes('bridge 重连后才补处理'))).toBe(true);
    expect(info.mock.calls.some((call) => call[0] === 'pending' && call[1] === 'handoff')).toBe(true);
    release();
  });

  it('reloads unrecorded pending after a SIGTERM-style disconnect', async () => {
    const history: Record<string, unknown[]> = { [CHAT]: [] };
    const h = await harness({ history });
    const queued = mention('om_term', 'survive restart');
    await h.channel.handlers.message?.(queued);
    history[CHAT] = [mentionHistory('om_term', queued.content, queued.createTime)];
    await h.ledger.flush();
    expect(h.ledger.has('om_term')).toBe(true);

    await h.bridge.disconnect();
    await h.ledger.flush();
    expect(h.ledger.has('om_term')).toBe(false);
    expect(h.ledger.getIncompleteFrom()).toBe(queued.createTime);

    const reloaded = new BackfillLedger(h.file);
    await reloaded.load();
    expect(reloaded.has('om_term')).toBe(false);
    expect(reloaded.getIncompleteFrom()).toBe(queued.createTime);

    sdk.channel = createRecordingLarkChannel({
      chats: [{ id: CHAT, name: 'G' }],
      messagesByChat: history,
    });
    const second = await startChannel({
      cfg: h.cfg,
      agent: h.agent,
      sessions: h.sessions,
      workspaces: h.workspaces,
      ledger: reloaded,
      controls: h.makeControls(),
    });
    cleanups.push(async () => { await second.disconnect().catch(() => {}); });
    await waitFor(() => h.agent.runOptions.some((opts) => opts.prompt.includes('survive restart')));
    expect(h.agent.runOptions.filter((opts) => opts.prompt.includes('survive restart'))).toHaveLength(1);
    expect(h.agent.runOptions.at(-1)?.prompt).toContain('bridge 重连后才补处理');
  });

  it('forces a short-gap scan from incompleteFrom after a 25s disconnect', async () => {
    const history: Record<string, unknown[]> = { [CHAT]: [] };
    const h = await harness({ history });
    const queued = mention('om_gap', 'during 25s gap');
    await h.channel.handlers.message?.(queued);
    history[CHAT] = [mentionHistory('om_gap', queued.content, queued.createTime)];
    const info = vi.spyOn(logger.log, 'info').mockImplementation(() => {});

    await h.bridge.disconnect();
    h.ledger.touchLive(Date.now() - 25_000);
    await h.ledger.flush();

    sdk.channel = createRecordingLarkChannel({
      chats: [{ id: CHAT, name: 'G' }],
      messagesByChat: history,
    });
    const second = await startChannel({
      cfg: h.cfg,
      agent: h.agent,
      sessions: h.sessions,
      workspaces: h.workspaces,
      ledger: h.ledger,
      controls: h.makeControls(),
    });
    cleanups.push(async () => { await second.disconnect().catch(() => {}); });
    await waitFor(() => h.agent.runOptions.some((opts) => opts.prompt.includes('during 25s gap')));
    expect(info.mock.calls.some((call) => call[0] === 'backfill' && call[1] === 'forced')).toBe(true);
    expect(info.mock.calls.some((call) => call[0] === 'backfill' && call[1] === 'skip-short-gap')).toBe(false);
  });

  it('keeps pending on /status and confirms plus retains ledger on /stop', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness({ hold });
    await h.channel.handlers.message?.(mention('om_run', 'start the run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 1);

    const queued = mention('om_keep', 'still pending');
    await h.channel.handlers.message?.(queued);
    await h.ledger.flush();
    expect(h.ledger.has('om_keep')).toBe(true);

    await h.channel.handlers.message?.(mention('om_status', '/status'));
    await h.ledger.flush();
    expect(h.ledger.has('om_keep')).toBe(true);
    expect(h.channel.snapshotCalls().some((call) => (
      call.op === 'send' && JSON.stringify(call.content).includes('已取消')
    ))).toBe(false);

    await h.channel.handlers.message?.(mention('om_stop', '/stop'));
    await h.ledger.flush();
    expect(h.ledger.has('om_keep')).toBe(true);
    expect(h.channel.snapshotCalls().some((call) => (
      call.op === 'send' && JSON.stringify(call.content).includes('已取消')
    ))).toBe(true);
    release();
  });

});

async function harness(opts: {
  hold?: Promise<void>;
  history?: Record<string, unknown[]>;
} = {}) {
  const tmp = await createTmpProfile('lost-message-');
  const file = join(tmp.profile, 'backfill-state.json');
  const ledger = new BackfillLedger(file);
  await ledger.load();
  const cfg = profile(tmp.workspace);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'claude',
    hold: opts.hold,
    waitForExit: false,
    events: [[{ type: 'system', resumeHandle: 'sess-hold' }]],
  });
  const history = opts.history ?? {};
  let channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }],
    messagesByChat: history,
  });
  sdk.channel = channel;
  const makeControls = () => ({
    profile: 'test',
    profileConfig: cfg,
    cfg,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {
      await state.bridge.disconnect().catch(() => {});
      channel = createRecordingLarkChannel({
        chats: [{ id: CHAT, name: 'G' }],
        messagesByChat: history,
      });
      sdk.channel = channel;
      state.channel = channel;
      state.bridge = await startChannel({
        cfg,
        agent,
        sessions,
        workspaces,
        ledger,
        controls: makeControls(),
      });
      await state.bridge.recoverMissed();
    },
    async exit() {},
    configPath: join(tmp.root, 'config.json'),
    processId: 'test-lost',
  });
  const state = {
    channel,
    bridge: await startChannel({
      cfg,
      agent,
      sessions,
      workspaces,
      ledger,
      controls: makeControls(),
    }),
  };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  cleanups.push(async () => {
    await state.bridge.disconnect().catch(() => {});
    await tmp.cleanup();
  });
  return {
    get channel() { return state.channel; },
    get bridge() { return state.bridge; },
    agent,
    ledger,
    file,
    cfg,
    sessions,
    workspaces,
    makeControls,
    restart: () => makeControls().restart(),
  };
}

function profile(workspace: string) {
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], admins: [USER] },
    preferences: { messageReply: 'text', cotMessages: 'off', requireMentionInGroup: true },
  });
  cfg.workspaces.default = workspace;
  return cfg;
}

function mention(
  messageId: string,
  content: string,
  extra: Partial<NormalizedMessage> = {},
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
    ...extra,
    mentionedBot: extra.mentionedBot ?? true,
    createTime: extra.createTime ?? Date.now(),
  } as NormalizedMessage;
}

function mentionHistory(messageId: string, text: string, createTime: number): Record<string, unknown> {
  return {
    message_id: messageId,
    chat_id: CHAT,
    msg_type: 'text',
    create_time: String(createTime),
    deleted: false,
    sender: { id: USER, id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: `@_user_1 ${text}` }) },
    mentions: [{ key: '@_user_1', id: BOT, id_type: 'open_id', name: 'Bot' }],
  };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(600);
    await yieldIO();
  }
  throw new Error('expected lost-message transition was not observed');
}

