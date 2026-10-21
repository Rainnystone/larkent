import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnJournal } from '../../../src/bot/turn-journal';
import type { CreateAutomationInput } from '../../../src/automations/store';
import { AutomationsStore } from '../../../src/automations/store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { closeLogger, configureLogger, flushLogger } from '../../../src/core/logger';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import type { AgentEvent } from '../../../src/agent/types';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { axiosErrno, axiosHttpError, axiosLike, sdkShapedSendError } from '../../helpers/sdk-feishu-errors';
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
const OTHER = 'oc_other';
const USER = 'ou_user';
const MATE = 'ou_mate';
const OWNER = 'ou_owner_9f3a';
const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const FIRE = Date.UTC(2026, 9, 19, 1, 0, 0);
const LOG_AT = new Date(Date.UTC(2026, 4, 25, 3, 0, 0));

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  sdk.channel = undefined;
});

describe('plugin summary and pre-tools reply recovery', () => {
  it('exposes only the short plugin summary before a task query, leaving task bodies and identities out', async () => {
    const h = await harness({
      events: done('先看一下。'),
      items: [
        item({ name: '总结马斯克推特', taskText: '总结马斯克推特', createdBy: OWNER }),
        item({ chatId: OTHER, name: '别的群', taskText: '别的群', createdBy: OWNER }),
      ],
      drafts: [item({ name: '未确认草稿', taskText: '未确认草稿' })],
    });
    await h.channel.handlers.message?.(mention('om_snap', '本群有哪些任务'));
    await waitFor(() => h.agent.runOptions.length === 1);
    const block = pluginSummary(h.agent.runOptions[0]?.prompt ?? '');
    expect(block).toContain('automation');
    expect(block).not.toContain('总结马斯克推特');
    expect(block).not.toContain('别的群');
    expect(block).not.toContain('未确认草稿');
    expect(block).not.toContain(OWNER);
    expect(block).not.toContain('ou_');
    expect(block).not.toContain('(你创建)');
  }, 15_000);

  it('does not claim an empty task list before a tool query', async () => {
    const h = await harness({ events: done('看看。') });
    await h.channel.handlers.message?.(mention('om_empty', '有任务吗'));
    await waitFor(() => h.agent.runOptions.length === 1);
    const block = pluginSummary(h.agent.runOptions[0]?.prompt ?? '');
    expect(block).not.toContain('本群暂无自动化任务');
    expect(block).toContain('automation');
  }, 15_000);

  it('does not inject the snapshot into a p2p prompt', async () => {
    const h = await harness({
      events: done('私聊不看群任务。'),
      items: [item({ name: '总结马斯克推特', taskText: '总结马斯克推特' })],
    });
    await h.channel.handlers.message?.(mention('om_dm', '本群有哪些任务', { chatType: 'p2p' }));
    await waitFor(() => h.agent.runOptions.length === 1);
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).not.toContain('本群当前自动化任务');
    expect(prompt).not.toContain('本群暂无自动化任务');
    expect(prompt).not.toContain('总结马斯克推特');
  }, 15_000);

  it('keeps the topic context while exposing the same short plugin summary', async () => {
    const h = await harness({
      events: done('话题里也能看到。'),
      items: [item({ name: '总结马斯克推特', taskText: '总结马斯克推特' })],
    });
    await h.channel.handlers.message?.(mention('om_topic', '本群有哪些任务', { threadId: 'omt_topic' }));
    await waitFor(() => h.agent.runOptions.length === 1);
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('omt_topic');
    expect(pluginSummary(prompt)).toContain('automation');
    expect(prompt).not.toContain('总结马斯克推特');
  }, 15_000);

  it.each([
    {
      name: 'HTTP 403',
      error: () => axiosHttpError(403, 'Request failed with status code 403'),
    },
    {
      name: 'recall window 230009',
      error: () => sdkShapedSendError('unknown', axiosLike('Message has expired when recall message.', {
        response: { status: 400, data: { code: 230009 } },
      })),
    },
  ])('settles the correction once when recall fails with $name', async ({ error }) => {
    const driven = await driveReplaceRecall({ recall: () => { throw error(); } });
    await driven.h.bridge.recover();
    await driven.h.bridge.recover();
    expect(correctionSends(driven.h)).toHaveLength(0);
    expect(driven.recallAttempts()).toBe(1);
    expect(correctionReply(driven.h)?.state).toBe('sent');
    expect(await logEvents(driven.h.logsDir, 'promise-recall-failed')).toHaveLength(1);
  }, 15_000);

  it('keeps a local recall failure staged and retries it without resending the correction', async () => {
    const driven = await driveReplaceRecall({
      recall: (attempt) => {
        if (attempt === 1) throw new TypeError('recall blew up');
      },
    });
    const beforeRetry = driven.recallAttempts();
    expect(beforeRetry).toBeGreaterThanOrEqual(1);
    expect(correctionSends(driven.h)).toHaveLength(0);
    expect(correctionReply(driven.h)?.state).toBe('staged');

    await driven.retry();
    expect(correctionSends(driven.h)).toHaveLength(0);
    expect(driven.recallAttempts()).toBe(beforeRetry + 1);
    expect(correctionReply(driven.h)?.state).toBe('sent');
  }, 15_000);

  it('settles a staged recall on the next recovery when the retry is outside the recall window', async () => {
    const driven = await driveReplaceRecall({
      recall: (attempt) => {
        if (attempt === 1) throw axiosErrno('ECONNRESET', 'connect ECONNRESET');
        throw sdkShapedSendError('unknown', axiosLike('Message has expired when recall message.', {
          response: { status: 400, data: { code: 230009 } },
        }));
      },
    });
    const beforeRetry = driven.recallAttempts();
    expect(beforeRetry).toBeGreaterThanOrEqual(1);
    expect(correctionReply(driven.h)?.state).toBe('staged');

    await driven.retry();
    expect(correctionSends(driven.h)).toHaveLength(0);
    expect(driven.recallAttempts()).toBe(beforeRetry + 1);
    expect(correctionReply(driven.h)?.state).toBe('sent');

    await driven.h.bridge.recover();
    expect(correctionSends(driven.h)).toHaveLength(0);
    expect(driven.recallAttempts()).toBe(beforeRetry + 1);
    expect(await logEvents(driven.h.logsDir, 'promise-recall-failed')).toHaveLength(beforeRetry + 1);
  }, 15_000);

  it('drops the chat on recovery when a staged recall then says the bot is outside the group', async () => {
    const driven = await driveReplaceRecall({
      items: [
        item(),
        item({ name: '留在本群', taskText: '留在本群' }),
        item({ chatId: OTHER, name: '别的群', taskText: '别的群' }),
      ],
      recall: (attempt) => {
        if (attempt === 1) throw axiosErrno('ECONNRESET', 'connect ECONNRESET');
        throw sdkShapedSendError('format_error', axiosLike('Your request specifies a chat which has already been dissolved.', {
          response: { status: 400, data: { code: 232009 } },
        }));
      },
    });
    const beforeRetry = driven.recallAttempts();
    expect(driven.h.store.list().some((entry) => entry.chatId === CHAT)).toBe(true);

    await driven.retry();
    await waitFor(() => driven.h.store.list().every((entry) => entry.chatId !== CHAT));
    expect(correctionSends(driven.h)).toHaveLength(0);
    expect(driven.recallAttempts()).toBe(beforeRetry + 1);
    expect(driven.h.store.list().map((entry) => entry.chatId)).toEqual([OTHER]);
    expect(correctionReply(driven.h)?.state).not.toBe('staged');

    await driven.h.bridge.recover();
    expect(driven.recallAttempts()).toBe(beforeRetry + 1);
    expect(await waitForLogged(
      driven.h.logsDir,
      'removed-from-chat',
      (events) => events.some((entry) => entry._chatId === CHAT),
    )).toEqual([
      expect.objectContaining({ _chatId: CHAT }),
    ]);
  }, 15_000);

});

function item(overrides: Partial<CreateAutomationInput> = {}): CreateAutomationInput {
  return {
    taskType: 'reminder',
    schedule: { kind: 'one-shot', fireAt: FIRE },
    timezone: TZ,
    startAt: NOW,
    nextFireAt: FIRE,
    chatId: CHAT,
    createdBy: USER,
    name: '总结马斯克推特',
    taskText: '总结马斯克推特',
    ...overrides,
  };
}

function done(text: string): readonly AgentEvent[] {
  return [
    { type: 'text', delta: text },
    { type: 'done', terminationReason: 'normal' },
  ];
}

async function harness(opts: {
  events: FakeAgentEvents;
  items?: CreateAutomationInput[];
  drafts?: CreateAutomationInput[];
  agentTasks?: boolean;
} = { events: [] }) {
  const tmp = await createTmpProfile('auto-a28-');
  const mediaDir = join(tmp.profile, 'media');
  const logsDir = join(tmp.profile, 'logs');
  await mkdir(mediaDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  configureLogger({ logsDir, retentionDays: 1, now: () => LOG_AT });
  let nowMs = NOW;
  const now = () => nowMs;
  const store = new AutomationsStore({
    path: join(tmp.profile, 'automations.json'),
    logPath: join(tmp.profile, 'automations.log'),
    statusPath: join(tmp.profile, 'automations-status.json'),
    now,
  });
  await store.load();
  for (const input of opts.items ?? []) await store.create(input);
  for (const input of opts.drafts ?? []) await store.saveDraft(input);
  const journal = new TurnJournal(join(tmp.profile, 'turn-journal.json'), { now });
  await journal.load();
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER, MATE], allowedChats: [CHAT, OTHER] },
    preferences: {
      requireMentionInGroup: true,
      messageReply: 'text',
      messageReplyMigrated: true,
      cotMessages: 'off',
    },
  });
  cfg.automations = { enabled: true, agentTasks: opts.agentTasks ?? false, timezone: TZ };
  cfg.workspaces.default = tmp.workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd(CHAT, tmp.workspace);
  const agent = new FakeAgentAdapter({ id: 'claude', events: opts.events });
  const channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }, { id: OTHER, name: 'Other' }],
    chatMode: 'group',
    botIdentity: { openId: 'ou_bot', name: 'Pin Bot' },
  });
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
    appPaths: {
      mediaDir,
      logsDir,
      secretsFile: join(tmp.profile, 'secrets.enc'),
      keystoreSaltFile: join(tmp.profile, '.keystore.salt'),
    },
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
      processId: 'test-auto-a28',
    },
  });
  cleanups.push(async () => {
    await bridge.disconnect().catch(() => {});
    await store.flush().catch(() => {});
    await journal.flush().catch(() => {});
    await closeLogger();
    await tmp.cleanup();
  });
  return {
    bridge,
    channel,
    store,
    journal,
    agent,
    logsDir,
    setNow(next: number) {
      nowMs = next;
    },
  };
}

function mention(
  messageId: string,
  content: string,
  extra: {
    senderId?: string;
    chatType?: 'p2p' | 'group';
    senderType?: 'user' | 'app';
    threadId?: string;
  } = {},
): NormalizedMessage {
  const chatType = extra.chatType ?? 'group';
  return {
    messageId,
    content,
    chatId: chatType === 'p2p' ? 'oc_dm' : CHAT,
    chatType,
    ...(extra.threadId ? { threadId: extra.threadId } : {}),
    senderId: extra.senderId ?? USER,
    senderName: 'User',
    rawContentType: 'text',
    resources: [],
    mentionedBot: true,
    createTime: NOW,
    raw: {
      sender: {
        sender_type: extra.senderType ?? 'user',
        sender_id: { open_id: extra.senderId ?? USER },
      },
    },
  } as unknown as NormalizedMessage;
}

function pluginSummary(prompt: string): string {
  const raw = prompt.match(/<bridge_instructions>\s*([\s\S]*?)\s*<\/bridge_instructions>/)?.[1];
  const instructions = JSON.parse(raw ?? '[]') as string[];
  const summary = instructions.find(text => text.includes('<bridge_plugins>'));
  expect(summary).toBeDefined();
  return summary!;
}

function correctionReply(h: { journal: TurnJournal }): { state?: string } | undefined {
  return h.journal.list().find((entry) => (
    entry.reply?.markdown.includes('没有删除任务：本群没有 #1')
  ))?.reply;
}

async function driveReplaceRecall(opts: {
  recall: (attempt: number) => void;
  items?: CreateAutomationInput[];
}): Promise<{
  h: Awaited<ReturnType<typeof harness>>;
  recallAttempts: () => number;
  retry(): Promise<void>;
}> {
  const h = await harness({ events: done('unused'), items: opts.items ?? [item()] });
  await h.bridge.tickLink();
  await h.bridge.recover();
  const old = await readFile(new URL('../../fixtures/automations/pre-tools-correction-v1.json', import.meta.url), 'utf8');
  await writeFile(h.journal.getFilePath(), old);
  await h.journal.load();
  let recallAttempts = 0;
  let retryAllowed = false;
  h.channel.recallMessage = async () => { recallAttempts++; opts.recall(retryAllowed ? 2 : 1); };
  await h.bridge.recover();
  await waitFor(() => recallAttempts >= 1);
  return { h, recallAttempts: () => recallAttempts, async retry() { retryAllowed = true; await h.bridge.recover(); } };
}

function correctionSends(h: { channel: ReturnType<typeof createRecordingLarkChannel> }): unknown[] {
  return h.channel.snapshotCalls().filter((call) => (
    call.op === 'send' && JSON.stringify(call.content).includes('没有删除任务：本群没有 #1')
  ));
}

async function logEvents(logsDir: string, event: string): Promise<Array<Record<string, unknown>>> {
  await flushLogger();
  const key = `${LOG_AT.getFullYear()}${String(LOG_AT.getMonth() + 1).padStart(2, '0')}${String(LOG_AT.getDate()).padStart(2, '0')}`;
  const text = await readFile(join(logsDir, `bridge-${key}.jsonl`), 'utf8');
  return text.trim().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === event);
}

async function waitForLogged(
  logsDir: string,
  event: string,
  ready: (events: Array<Record<string, unknown>>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 8_000;
  let found: Array<Record<string, unknown>> = [];
  while (Date.now() < deadline) {
    try {
      found = await logEvents(logsDir, event);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      found = [];
    }
    if (ready(found)) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await yieldIO();
  }
  throw new Error('timed out waiting for the natural-language delete or replace flow');
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await yieldIO();
  }
  throw new Error('timed out waiting for the natural-language delete or replace flow');
}
