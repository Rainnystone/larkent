import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { TurnJournal } from '../../../src/bot/turn-journal';
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
const ANSWER = 'JOURNAL_FINAL';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('turn journal in the live channel', { timeout: 20_000 }, () => {
  it('posts a 上一轮未完成 notice once when recovering a running turn after restart', async () => {
    const h = await harness({ fakeTimers: false });
    h.journal.enqueue({
      turnId: 'turn-crash',
      scope: CHAT,
      chatId: CHAT,
      messageIds: ['om_crash'],
      senderId: USER,
      initiatorId: USER,
      status: 'running',
      runId: 'run-crash',
    });
    await h.journal.flush();

    await h.bridge.recoverMissed();
    await waitFor(() => h.channel.sent.some((item) => JSON.stringify(item.content).includes('上一轮未完成')));
    expect(h.journal.get('turn-crash')?.status).toBe('notice-delivered');

    const before = h.channel.sent.length;
    await h.bridge.recoverMissed();
    expect(h.channel.sent).toHaveLength(before);
  });

  it('marks a failed final send completed-undelivered and resends once on recoverMissed', async () => {
    const h = await harness({ fakeTimers: false });
    let fails = 1;
    const orig = h.channel.send.bind(h.channel);
    h.channel.send = async (...args: Parameters<typeof orig>) => {
      if (fails > 0) {
        fails -= 1;
        throw sdkShapedSendError('send_timeout', axiosErrno('ECONNABORTED', 'timeout of 30000ms exceeded'));
      }
      return orig(...args);
    };

    await h.channel.handlers.message?.(mention('om_run', 'please answer'));
    await waitFor(() => h.journal.list().some((entry) => entry.status === 'completed-undelivered'));
    expect(h.channel.sent).toEqual([]);

    await h.bridge.recoverMissed();
    await waitFor(() => h.journal.list().some((entry) => entry.status === 'reply-delivered'));
    expect(h.channel.sent).toHaveLength(1);
    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain(ANSWER);

    await h.bridge.recoverMissed();
    expect(h.channel.sent).toHaveLength(1);
  });

  it('resends an undelivered failure while the long connection stays up', async () => {
    const h = await harness({ fakeTimers: false });
    let fails = 1;
    const orig = h.channel.send.bind(h.channel);
    h.channel.send = async (...args: Parameters<typeof orig>) => {
      if (fails > 0) {
        fails -= 1;
        throw sdkShapedSendError(
          'unknown',
          axiosErrno(
            'ECONNRESET',
            'Client network socket disconnected before secure TLS connection was established',
          ),
        );
      }
      return orig(...args);
    };

    await h.channel.handlers.message?.(mention('om_tls', 'please answer'));
    await waitFor(() => h.journal.list().some((entry) => entry.status === 'completed-undelivered'));
    expect(h.channel.sent).toEqual([]);

    await h.bridge.recoverMissed();
    await waitFor(() => h.journal.list().some((entry) => entry.status === 'reply-delivered'));
    expect(h.channel.sent).toHaveLength(1);
  });

  it.each(['/new', '/cd', '/ws use saved', '/resume use sess-1'] as const)(
    'voids the incomplete journal record after %s',
    async (command) => {
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = await harness({ hold, complete: false });
      if (command === '/ws use saved') {
        await h.channel.handlers.message?.(mention('om_save', '/ws save saved'));
        await vi.advanceTimersByTimeAsync(600);
      }
      const text = command === '/cd' ? `/cd ${h.workspace}` : command;

      await h.channel.handlers.message?.(mention('om_run', 'start the run'));
      await vi.advanceTimersByTimeAsync(600);
      await waitFor(() => h.agent.runOptions.length === 1);
      await waitFor(() => h.journal.list().some((entry) => (
        entry.messageIds.includes('om_run')
        && (entry.status === 'queued' || entry.status === 'running')
      )));

      await h.channel.handlers.message?.(mention('om_switch', text));
      await h.journal.flush();
      expect(
        h.journal.list(),
        `after ${text}: ${JSON.stringify(h.journal.list())}`,
      ).toEqual(expect.arrayContaining([
        expect.objectContaining({ messageIds: expect.arrayContaining(['om_run']), status: 'voided' }),
      ]));
      release();
    },
  );

  it('settles a streamed card turn instead of leaving it running', async () => {
    const h = await harness({ fakeTimers: false, replyMode: 'card' });
    await h.channel.handlers.message?.(mention('om_run', 'please answer'));
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_run') && entry.status === 'reply-delivered'
    )));
  });

  it('a rejected final patch stays staged in both markdown and card mode, then is recovered by patching the same card', async () => {
    for (const replyMode of ['markdown', 'card'] as const) {
      const h = await harness({ fakeTimers: false, replyMode });
      h.channel.streamErrors.finish = sdkShapedSendError(
        'unknown',
        axiosErrno('EAI_AGAIN', 'getaddrinfo EAI_AGAIN open.feishu.cn'),
      );

      await h.channel.handlers.message?.(mention('om_run', 'please answer'));
      await waitFor(() => h.journal.list().some((entry) => (
        entry.messageIds.includes('om_run') && entry.status === 'completed-undelivered'
      )));
      const staged = h.journal.list().find((entry) => entry.messageIds.includes('om_run'));
      const streamId = h.channel.streams[0]?.messageId;
      expect(streamId).toBeTruthy();
      expect(staged?.reply?.markdown).toContain(ANSWER);
      expect(staged?.reply?.replyTo).toBe('om_run');
      expect(staged?.reply?.messageId).toBe(streamId);
      expect(answerSends(h.channel)).toHaveLength(0);

      await h.bridge.recoverMissed();
      await waitFor(() => h.journal.list().some((entry) => (
        entry.messageIds.includes('om_run') && entry.status === 'reply-delivered'
      )));
      expect(answerSends(h.channel)).toHaveLength(0);
      expect(h.channel.updatedCards.some((row) => (
        row.messageId === streamId && JSON.stringify(row.card).includes(ANSWER)
      ))).toBe(true);
      const delivered = h.journal.list().find((entry) => entry.messageIds.includes('om_run'));
      expect(delivered?.reply?.messageId).toBe(streamId);

      await h.bridge.recoverMissed();
      expect(answerSends(h.channel)).toHaveLength(0);
    }
  });

  it('does not mark an in-flight run interrupted on WebSocket reconnected', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness({ hold, complete: false });
    await h.channel.handlers.message?.(mention('om_run', 'start the run'));
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => h.agent.runOptions.length === 1);
    await waitFor(() => h.journal.list().some((entry) => (
      entry.messageIds.includes('om_run')
      && (entry.status === 'queued' || entry.status === 'running')
    )));
    h.channel.emit('reconnected');
    await yieldIO();
    await h.journal.flush();
    expect(h.journal.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        messageIds: expect.arrayContaining(['om_run']),
        status: expect.stringMatching(/queued|running/),
      }),
    ]));
    release();
  });

});

async function harness(opts: {
  hold?: Promise<void>;
  complete?: boolean;
  fakeTimers?: boolean;
  replyMode?: 'text' | 'card' | 'markdown';
} = {}) {
  const tmp = await createTmpProfile('turn-journal-');
  const file = join(tmp.profile, 'turn-journal.json');
  const journal = new TurnJournal(file);
  await journal.load();
  const cfg = profile(tmp.workspace, opts.replyMode);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const complete = opts.complete !== false;
  const agent = new FakeAgentAdapter({
    id: 'claude',
    hold: opts.hold,
    waitForExit: complete,
    events: complete
      ? [[{
        type: 'text',
        delta: ANSWER,
      }, {
        type: 'final_text',
        content: ANSWER,
      }, {
        type: 'done',
        terminationReason: 'normal',
        resumeHandle: 'sess-1',
      }]]
      : [[{ type: 'system', resumeHandle: 'sess-hold' }]],
  });
  const channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }],
  });
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    journal,
    controls: {
      profile: 'test',
      profileConfig: cfg,
      cfg,
      ownerRefreshState: 'unknown' as const,
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      processId: 'test-journal',
    },
  });
  if (opts.fakeTimers !== false) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  }
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await tmp.cleanup();
  });
  return {
    channel,
    bridge,
    agent,
    journal,
    file,
    workspace: tmp.workspace,
  };
}

function profile(workspace: string, replyMode: 'text' | 'card' | 'markdown' = 'text') {
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], admins: [USER] },
    preferences: {
      messageReply: replyMode,
      messageReplyMigrated: true,
      cotMessages: 'off',
      requireMentionInGroup: true,
    },
  });
  cfg.workspaces.default = workspace;
  return cfg;
}

function answerSends(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return channel.sent.filter((item) => JSON.stringify(item.content).includes(ANSWER));
}

function mention(messageId: string, content: string): NormalizedMessage {
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
    createTime: Date.now(),
  } as unknown as NormalizedMessage;
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(600);
    else await new Promise((resolve) => setTimeout(resolve, 25));
    await yieldIO();
  }
  throw new Error('expected turn-journal transition was not observed');
}
