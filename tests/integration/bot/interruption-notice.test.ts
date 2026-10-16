import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { CONTINUE_HINT } from '../../../src/bot/interruption-notice';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent';
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
const USER = 'ou_user';
const MATE = 'ou_mate';
const OWNER = 'ou_owner';
const SECRET = 'SECRET_PROMPT_TOKEN';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.channel = undefined;
});

describe('interruption notice in the live channel', { timeout: 20_000 }, () => {
  it('posts a continue card, resumes without replaying the original prompt, and rejects a replayed nonce', async () => {
    const h = await harness({
      events: [
        [{ type: 'system', resumeHandle: 'sess-1' }, { type: 'done', terminationReason: 'interrupted' }],
        [{ type: 'text', delta: 'CONTINUED' }, { type: 'final_text', content: 'CONTINUED' }, { type: 'done', terminationReason: 'normal', resumeHandle: 'sess-1' }],
      ],
    });
    await h.channel.handlers.message?.(mention('om_run', SECRET));
    await waitFor(() => noticeCards(h.channel).length === 1);
    const card = noticeCards(h.channel)[0]!;
    expect(JSON.stringify(card.content)).toContain('@bot');
    expect(JSON.stringify(card.content)).toContain('继续');
    expect(JSON.stringify(card.options)).not.toContain(SECRET);

    const token = continueToken(card);
    await h.channel.handlers.cardAction?.(cardClick(USER, token));
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBe('sess-1');
    expect(h.agent.runOptions[1]?.prompt).toContain(CONTINUE_HINT);
    expect(h.agent.runOptions[1]?.prompt).not.toContain(SECRET);
    await waitFor(() => h.channel.sent.some((item) => JSON.stringify(item.content).includes('CONTINUED')));
    const continued = h.channel.sent.find((item) => JSON.stringify(item.content).includes('CONTINUED'));
    expect(continued?.options).toMatchObject({ replyTo: 'om_notice' });
    await waitFor(() => resolvedCards(h.channel).some((card) => JSON.stringify(card).includes('已继续')));
    expect(JSON.stringify(resolvedCards(h.channel).at(-1))).not.toContain('notice.continue');

    const sentBefore = h.channel.sent.length;
    await h.channel.handlers.cardAction?.(cardClick(USER, token));
    await yieldIO();
    expect(h.agent.runOptions.length).toBe(2);
    expect(h.channel.sent.length).toBeGreaterThan(sentBefore);
  });

  it('lets an allowed teammate continue and rejects a fenced-out owner', async () => {
    const h = await harness({
      fence: true,
      events: [
        [{ type: 'system', resumeHandle: 'sess-1' }, { type: 'done', terminationReason: 'interrupted' }],
        [{ type: 'text', delta: 'OK' }, { type: 'final_text', content: 'OK' }, { type: 'done', terminationReason: 'normal', resumeHandle: 'sess-1' }],
      ],
    });
    await h.channel.handlers.message?.(mention('om_run', SECRET));
    await waitFor(() => noticeCards(h.channel).length === 1);
    const token = continueToken(noticeCards(h.channel)[0]!);
    await h.channel.handlers.cardAction?.(cardClick(OWNER, token));
    await yieldIO();
    expect(h.agent.runOptions.length).toBe(1);
    await h.channel.handlers.cardAction?.(cardClick(MATE, token));
    await waitFor(() => h.agent.runOptions.length === 2);
  });

  it.each(['/new', `/cd workspace`] as const)('invalidates the notice after %s', async (command) => {
    const h = await harness({
      events: [
        [{ type: 'system', resumeHandle: 'sess-1' }, { type: 'done', terminationReason: 'interrupted' }],
      ],
    });
    await h.channel.handlers.message?.(mention('om_run', SECRET));
    await waitFor(() => noticeCards(h.channel).length === 1);
    const token = continueToken(noticeCards(h.channel)[0]!);
    const text = command === '/new' ? '/new' : `/cd ${h.workspace}`;
    await h.channel.handlers.message?.(mention('om_switch', text));
    await vi.advanceTimersByTimeAsync(600);
    await h.channel.handlers.cardAction?.(cardClick(USER, token));
    await yieldIO();
    expect(h.agent.runOptions.length).toBe(1);
    expect(JSON.stringify(h.channel.sent)).toMatch(/失效/);
  });

  it('reruns the original batch when there is no resume handle', async () => {
    const h = await harness({
      events: [
        [{ type: 'done', terminationReason: 'interrupted' }],
        [{ type: 'text', delta: 'RERUN' }, { type: 'final_text', content: 'RERUN' }, { type: 'done', terminationReason: 'normal' }],
      ],
    });
    await h.channel.handlers.message?.(mention('om_run', SECRET));
    await waitFor(() => noticeCards(h.channel).length === 1);
    const workspaceRealpath = await realpath(h.workspace);
    h.sessions.set(CHAT, 'sess-stale', workspaceRealpath);
    await h.channel.handlers.cardAction?.(cardClick(USER, continueToken(noticeCards(h.channel)[0]!)));
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBeUndefined();
    expect(h.agent.runOptions[1]?.prompt).toContain(SECRET);
    expect(h.agent.runOptions[1]?.prompt).toContain(CONTINUE_HINT);
  });

  it('sends plain text with no buttons on the fourth consecutive interrupt, and resets after an ordinary message', async () => {
    const h = await harness({
      events: [
        [{ type: 'done', terminationReason: 'interrupted' }],
        [{ type: 'done', terminationReason: 'interrupted' }],
        [{ type: 'done', terminationReason: 'interrupted' }],
        [{ type: 'done', terminationReason: 'interrupted' }],
        [{ type: 'text', delta: 'ok' }, { type: 'final_text', content: 'ok' }, { type: 'done', terminationReason: 'normal' }],
        [{ type: 'done', terminationReason: 'interrupted' }],
      ],
    });
    await h.channel.handlers.message?.(mention('om_1', SECRET));
    await waitFor(() => noticeCards(h.channel).length === 1);
    for (const round of [1, 2, 3]) {
      const cards = noticeCards(h.channel);
      await h.channel.handlers.cardAction?.(cardClick(USER, continueToken(cards[cards.length - 1]!)));
      await waitFor(() => h.agent.runOptions.length === round + 1);
      await waitFor(() => noticeCards(h.channel).length === round + 1 || plainNotices(h.channel).length > 0);
    }
    expect(plainNotices(h.channel).length).toBeGreaterThan(0);
    expect(JSON.stringify(plainNotices(h.channel).at(-1)?.content)).not.toContain('notice.continue');

    await h.channel.handlers.message?.(mention('om_ordinary', '请改另一个文件'));
    await waitFor(() => h.agent.runOptions.length === 5);
    expect(h.agent.runOptions[4]?.prompt).toContain(CONTINUE_HINT);
    const cardsBeforeReset = noticeCards(h.channel).length;
    await h.channel.handlers.message?.(mention('om_after_reset', SECRET));
    await waitFor(() => noticeCards(h.channel).length > cardsBeforeReset);
  });

  it('resets the consecutive notice streak after /new', async () => {
    const h = await harness({
      events: [
        [{ type: 'done', terminationReason: 'interrupted' }],
        [{ type: 'done', terminationReason: 'interrupted' }],
        [{ type: 'done', terminationReason: 'interrupted' }],
        [{ type: 'done', terminationReason: 'interrupted' }],
      ],
    });
    await h.channel.handlers.message?.(mention('om_1', SECRET));
    await waitFor(() => noticeCards(h.channel).length === 1);
    for (const round of [1, 2]) {
      const cards = noticeCards(h.channel);
      await h.channel.handlers.cardAction?.(cardClick(USER, continueToken(cards[cards.length - 1]!)));
      await waitFor(() => noticeCards(h.channel).length === round + 1);
    }
    await h.channel.handlers.message?.(mention('om_new', '/new'));
    await vi.advanceTimersByTimeAsync(600);
    await h.channel.handlers.message?.(mention('om_after_new', SECRET));
    await waitFor(() => noticeCards(h.channel).length === 4);
    expect(plainNotices(h.channel)).toHaveLength(0);
  });

  it('threads a topic-group notice onto the original topic', async () => {
    const h = await harness({
      topic: true,
      events: [[{ type: 'done', terminationReason: 'interrupted' }]],
    });
    await h.channel.handlers.message?.(mention('om_run', SECRET, { threadId: 'th_1' }));
    await waitFor(() => noticeSends(h.channel).length === 1);
    expect(noticeSends(h.channel)[0]?.options).toMatchObject({ replyInThread: true });
  });

  it('resends a failed notice exactly once after recoverMissed', async () => {
    const h = await harness({
      fakeTimers: false,
      events: [[{ type: 'done', terminationReason: 'interrupted' }]],
    });
    let fails = 1;
    const orig = h.channel.send.bind(h.channel);
    h.channel.send = async (...args: Parameters<typeof orig>) => {
      const content = args[1] as { card?: unknown; markdown?: string };
      if (isNoticeContent(content) && fails > 0) {
        fails -= 1;
        throw new Error('sdk timeout');
      }
      return orig(...args);
    };
    await h.channel.handlers.message?.(mention('om_run', SECRET));
    await waitFor(() => fails === 0 && h.journal.list().some((entry) => entry.status === 'notice-pending'));
    await h.bridge.recoverMissed();
    await waitFor(() => h.journal.list().some((entry) => entry.status === 'notice-delivered'));
    const notices = h.channel.sent.filter((item) => isNoticeContent(item.content));
    expect(notices).toHaveLength(1);
    await h.bridge.recoverMissed();
    expect(h.channel.sent.filter((item) => isNoticeContent(item.content))).toHaveLength(1);
  });

  it('notifies initiator and owner once for auth-required and still accepts a new run', async () => {
    const h = await harness({
      agentKind: 'cursor',
      owner: true,
      events: [
        [{ type: 'error', message: "Your stored authentication is invalid. Please run 'agent login'.", terminationReason: 'failed' }],
        [{ type: 'error', message: "Your stored authentication is invalid. Please run 'agent login'.", terminationReason: 'failed' }],
        [{ type: 'text', delta: 'NEW' }, { type: 'final_text', content: 'NEW' }, { type: 'done', terminationReason: 'normal' }],
      ],
    });
    await h.channel.handlers.message?.(mention('om_auth', 'please run'));
    await waitFor(() => h.channel.sent.some((item) => item.chatId === OWNER));
    const initiatorNotes = h.channel.sent.filter((item) => (
      item.chatId === CHAT && JSON.stringify(item.content).includes('不能继续')
    ));
    const ownerNotes = h.channel.sent.filter((item) => item.chatId === OWNER);
    expect(initiatorNotes).toHaveLength(1);
    expect(ownerNotes).toHaveLength(1);
    expect(JSON.stringify(initiatorNotes[0]?.content)).not.toContain('notice.continue');

    await h.channel.handlers.message?.(mention('om_auth2', 'please run again'));
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.channel.sent.filter((item) => item.chatId === OWNER)).toHaveLength(1);
    expect(h.channel.sent.filter((item) => (
      item.chatId === CHAT && JSON.stringify(item.content).includes('不能继续')
    ))).toHaveLength(1);

    await h.channel.handlers.message?.(mention('om_newrun', 'try a new task'));
    await waitFor(() => h.agent.runOptions.length === 3);
    expect(h.agent.runOptions[2]?.prompt).toContain('try a new task');
  });

  it('does not send a notice when the flag is off', async () => {
    const h = await harness({
      notice: false,
      events: [[{ type: 'done', terminationReason: 'interrupted' }]],
    });
    await h.channel.handlers.message?.(mention('om_run', SECRET));
    await waitFor(() => h.agent.runs.length === 1);
    await waitFor(() => h.journal.list().some((entry) => (
      entry.status === 'reply-delivered' || entry.status === 'interrupted' || entry.status === 'settled'
    )));
    expect(noticeSends(h.channel)).toEqual([]);
  });

  it('stages a notice before a failed final reply so recover can resend it', async () => {
    const h = await harness({
      fakeTimers: false,
      events: [[{ type: 'text', delta: 'PARTIAL' }, { type: 'done', terminationReason: 'interrupted' }]],
    });
    h.channel.send = async () => {
      throw new Error('sdk timeout');
    };
    await h.channel.handlers.message?.(mention('om_run', SECRET));
    await waitFor(() => h.journal.list().some((entry) => entry.status === 'notice-pending'));
  });

  it('replays original attachments when Continue has no resume handle', async () => {
    const h = await harness({
      events: [
        [{ type: 'done', terminationReason: 'interrupted' }],
        [{ type: 'text', delta: 'SAW FILE' }, { type: 'final_text', content: 'SAW FILE' }, { type: 'done', terminationReason: 'normal' }],
      ],
    });
    await h.channel.handlers.message?.(mention('om_run', 'see the file', {
      resources: [{ type: 'file', fileKey: 'file_v2_secret' }],
    }));
    await waitFor(() => noticeCards(h.channel).length === 1);
    expect(h.journal.list()[0]?.resources).toEqual([
      { type: 'file', fileKey: 'file_v2_secret', sourceMessageId: 'om_run' },
    ]);
    const token = continueToken(noticeCards(h.channel)[0]!);
    await h.channel.handlers.cardAction?.(cardClick(USER, token));
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBeUndefined();
    expect(h.agent.runOptions[1]?.prompt).toContain('see the file');
    expect(h.channel.callLog.filter((call) => call.op === 'download')).toEqual([
      expect.objectContaining({ op: 'download', messageId: 'om_run', fileKey: 'file_v2_secret' }),
      expect.objectContaining({ op: 'download', messageId: 'om_run', fileKey: 'file_v2_secret' }),
    ]);
    await waitFor(() => h.channel.sent.some((item) => JSON.stringify(item.content).includes('SAW FILE')));
    expect(h.channel.sent.find((item) => JSON.stringify(item.content).includes('SAW FILE'))?.options)
      .toMatchObject({ replyTo: 'om_notice' });
  });

  it('starts the same continue request from @bot 继续 text', async () => {
    const h = await harness({
      events: [
        [{ type: 'system', resumeHandle: 'sess-1' }, { type: 'done', terminationReason: 'interrupted' }],
        [{ type: 'text', delta: 'CONTINUED' }, { type: 'final_text', content: 'CONTINUED' }, { type: 'done', terminationReason: 'normal', resumeHandle: 'sess-1' }],
      ],
    });
    await h.channel.handlers.message?.(mention('om_run', SECRET));
    await waitFor(() => noticeCards(h.channel).length === 1);
    await h.channel.handlers.message?.(mention('om_cont', '@_user_1 继续'));
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]?.resumeHandle).toBe('sess-1');
    expect(h.agent.runOptions[1]?.prompt).not.toContain(SECRET);
    expect(h.agent.runOptions[1]?.prompt).toContain(CONTINUE_HINT);
  });

  it('resolves the notice card on typed 继续 and ignores a later button click', async () => {
    const h = await harness({
      events: [
        [{ type: 'system', resumeHandle: 'sess-1' }, { type: 'done', terminationReason: 'interrupted' }],
        [{ type: 'text', delta: 'CONTINUED' }, { type: 'final_text', content: 'CONTINUED' }, { type: 'done', terminationReason: 'normal', resumeHandle: 'sess-1' }],
        [{ type: 'text', delta: 'SECOND' }, { type: 'final_text', content: 'SECOND' }, { type: 'done', terminationReason: 'normal', resumeHandle: 'sess-1' }],
      ],
    });
    await h.channel.handlers.message?.(mention('om_run', SECRET));
    await waitFor(() => noticeCards(h.channel).length === 1);
    const token = continueToken(noticeCards(h.channel)[0]!);
    const noticeId = h.journal.list().find((entry) => entry.notice?.messageId)?.notice?.messageId;
    expect(noticeId).toBeTruthy();

    await h.channel.handlers.message?.(mention('om_cont', '@_user_1 继续'));
    await waitFor(() => h.agent.runOptions.length === 2);
    await waitFor(() => resolvedCards(h.channel).some((card) => JSON.stringify(card).includes('已继续')));
    const resolved = resolvedCards(h.channel).at(-1)!;
    expect(JSON.stringify(resolved)).toContain('已继续');
    expect(JSON.stringify(resolved)).not.toContain('notice.continue');
    expect(JSON.stringify(resolved)).not.toContain('暂不');
    expect(h.channel.callLog.some((call) => call.op === 'updateCard' && call.messageId === noticeId)).toBe(true);

    const sentBefore = h.channel.sent.length;
    await h.channel.handlers.cardAction?.(cardClick(USER, token));
    await yieldIO();
    expect(h.agent.runOptions.length).toBe(2);
    expect(JSON.stringify(h.channel.sent.slice(sentBefore))).toMatch(/失效/);
    expect(JSON.stringify(h.channel.sent)).not.toContain('SECOND');
  });

  it('sends one notice card when recover races a still-in-flight send', async () => {
    const h = await harness({
      fakeTimers: false,
      events: [[{ type: 'done', terminationReason: 'interrupted' }]],
    });
    let release: (() => void) | undefined;
    const orig = h.channel.send.bind(h.channel);
    h.channel.send = async (...args: Parameters<typeof orig>) => {
      const content = args[1] as { card?: unknown; markdown?: string };
      if (isNoticeContent(content) && !release) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return orig(...args);
    };
    const started = h.channel.handlers.message?.(mention('om_run', SECRET));
    await waitFor(() => release !== undefined);
    const recovering = h.bridge.recoverMissed();
    await yieldIO();
    release?.();
    await started;
    await recovering;
    expect(h.channel.sent.filter((item) => isNoticeContent(item.content))).toHaveLength(1);
    await h.bridge.recoverMissed();
    expect(h.channel.sent.filter((item) => isNoticeContent(item.content))).toHaveLength(1);
  });

  it('does not post a second notice after a timed-out send later lands', async () => {
    const h = await harness({
      fakeTimers: false,
      events: [[{ type: 'done', terminationReason: 'interrupted' }]],
    });
    const orig = h.channel.send.bind(h.channel);
    let firstNotice = true;
    h.channel.send = async (...args: Parameters<typeof orig>) => {
      const content = args[1] as { card?: unknown; markdown?: string };
      if (isNoticeContent(content) && firstNotice) {
        firstNotice = false;
        const landed = await orig(...args);
        throw Object.assign(new Error('timeout of 30000ms exceeded'), { landed });
      }
      return orig(...args);
    };
    await h.channel.handlers.message?.(mention('om_run', SECRET));
    await waitFor(() => h.journal.list().some((entry) => entry.status === 'notice-pending' && entry.notice?.deliveryId));
    const entry = h.journal.list().find((item) => item.notice);
    const landedId = h.channel.sent.find((item) => isNoticeContent(item.content))
      ? (h.journal.get(entry!.turnId)?.notice?.messageId ?? 'om_late')
      : 'om_late';
    h.journal.noteDelivery(entry!.notice!.deliveryId!, landedId);
    expect(h.journal.get(entry!.turnId)?.status).toBe('notice-delivered');
    await h.bridge.recoverMissed();
    expect(h.channel.sent.filter((item) => isNoticeContent(item.content)).length).toBeLessThanOrEqual(1);
    expect(h.journal.get(entry!.turnId)?.status).toBe('notice-delivered');
  });
});

async function harness(opts: {
  events?: FakeAgentEvents;
  notice?: boolean;
  fence?: boolean;
  topic?: boolean;
  owner?: boolean;
  agentKind?: 'claude' | 'cursor';
  fakeTimers?: boolean;
} = {}) {
  const tmp = await createTmpProfile('notice-channel-');
  const mediaDir = join(tmp.profile, 'media');
  await mkdir(mediaDir, { recursive: true });
  const file = join(tmp.profile, 'turn-journal.json');
  const journal = new TurnJournal(file);
  await journal.load();
  const cfg = profile(tmp.workspace, opts);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: opts.agentKind ?? 'claude',
    events: opts.events ?? [[{ type: 'done', terminationReason: 'interrupted' }]],
  });
  const channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }],
    chatMode: opts.topic ? 'topic' : 'group',
    botIdentity: { openId: 'ou_bot', name: 'Pin Bot' },
  });
  sdk.channel = channel;
  const bridge = await startChannel({
    cfg,
    agent,
    sessions,
    workspaces,
    journal,
    appPaths: { mediaDir, secretsFile: join(tmp.profile, 'secrets.enc'), keystoreSaltFile: join(tmp.profile, '.keystore.salt') },
    controls: {
      profile: 'test',
      profileConfig: cfg,
      cfg,
      botOwnerId: OWNER,
      ownerRefreshState: 'ok',
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(tmp.root, 'config.json'),
      processId: 'test-notice',
    },
  });
  if (opts.fakeTimers !== false) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  }
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await tmp.cleanup();
  });
  return { channel, bridge, agent, journal, workspace: tmp.workspace, sessions };
}

function profile(workspace: string, opts: { notice?: boolean; fence?: boolean; agentKind?: 'claude' | 'cursor' }) {
  const cfg = createDefaultProfileConfig({
    agentKind: opts.agentKind ?? 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: {
      allowedUsers: [USER, MATE],
      allowedChats: [CHAT],
      admins: [USER],
      ...(opts.fence ? { fence: { enabled: true } } : {}),
    },
    preferences: {
      messageReply: 'text',
      messageReplyMigrated: true,
      cotMessages: 'off',
      requireMentionInGroup: true,
    },
    reliability: {
      notice: opts.notice !== false,
    },
  });
  cfg.workspaces.default = workspace;
  return cfg;
}

function mention(
  messageId: string,
  content: string,
  extra: {
    threadId?: string;
    senderId?: string;
    resources?: Array<{ type: string; fileKey: string }>;
  } = {},
): NormalizedMessage {
  return {
    messageId,
    content,
    chatId: CHAT,
    chatType: 'group',
    senderId: extra.senderId ?? USER,
    senderName: 'User',
    rawContentType: extra.resources?.length ? 'file' : 'text',
    resources: extra.resources ?? [],
    mentionedBot: true,
    createTime: Date.now(),
    ...(extra.threadId ? { threadId: extra.threadId } : {}),
  } as unknown as NormalizedMessage;
}

function cardClick(operatorId: string, token: string): CardActionEvent {
  return {
    action: { value: { cmd: 'notice.continue', notice_token: token } },
    chatId: CHAT,
    messageId: 'om_notice',
    operator: { openId: operatorId, name: 'Op' },
  } as unknown as CardActionEvent;
}

function isNoticeContent(content: unknown): boolean {
  const json = JSON.stringify(content);
  return json.includes('notice.continue') || json.includes('中断通知') || json.includes(CONTINUE_HINT);
}

function noticeSends(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return channel.sent.filter((item) => isNoticeContent(item.content));
}

function noticeCards(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return noticeSends(channel).filter((item) => JSON.stringify(item.content).includes('notice.continue'));
}

function plainNotices(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return noticeSends(channel).filter((item) => !JSON.stringify(item.content).includes('notice.continue'));
}

function resolvedCards(channel: ReturnType<typeof createRecordingLarkChannel>) {
  return channel.callLog
    .filter((call): call is Extract<typeof call, { op: 'updateCard' }> => call.op === 'updateCard')
    .map((call) => call.card);
}

function continueToken(send: { content: unknown }): string {
  const json = JSON.stringify(send.content);
  const match = json.match(/"notice_token":"([^"]+)"/);
  if (!match?.[1]) throw new Error(`missing notice token in ${json}`);
  return match[1];
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(600);
    else await new Promise((resolve) => setTimeout(resolve, 25));
    await yieldIO();
  }
  throw new Error('expected interruption-notice transition was not observed');
}
