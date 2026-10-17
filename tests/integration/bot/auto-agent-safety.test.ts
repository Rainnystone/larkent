import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatFireKey, type Schedule } from '../../../src/automations/schedule';
import { AutomationsStore } from '../../../src/automations/store';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { log } from '../../../src/core/logger';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import type { AgentEvent } from '../../../src/agent/types';
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
const FOOTER = '在本消息话题里追问';
const TASK = '汇总昨天的 issue';
const FIRE_ONE = 'FIRE_ONE_RESULT';
const HUMAN = 'HUMAN_CHAT_ANSWER';
const POLICY_NOTICE = '策略拦截';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  sdk.channel = undefined;
});

describe('automation agent-task safety whitelist', { timeout: 20_000 }, () => {
  it('blocks member add, pauses the task, posts a notice, and writes a redacted policy-guard log', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const h = await harness({
      nowMs: t0,
      seed: true,
      events: [bashRun('lark-cli im chat.members create --chat-id oc_group --data \'{"id_list":["ou_victim"]}\'')],
    });

    await waitFor(() => outboxBodies(h.channel).some((body) => body.includes(POLICY_NOTICE)));
    const status = await waitForStatus(h, (snapshot) => snapshot.items[0]?.paused === true);

    expect(outboxBodies(h.channel).join('\n')).toContain(POLICY_NOTICE);
    expect(outboxBodies(h.channel).join('\n')).toContain(FOOTER);
    expect(outboxBodies(h.channel).join('\n')).not.toContain('继续');
    expect(JSON.stringify(h.channel.sent)).not.toContain('notice.continue');
    expect(status.items).toEqual([expect.objectContaining({
      id: 1,
      paused: true,
    })]);
    expect(h.store.get(1)?.paused).toBe(true);
    expect(h.cfg.larkCli.identityPreset).toBe('user-default');

    const audit = await waitForLog(h, (entries) => entries.some((entry) => entry.result === 'policy-guard'));
    expect(audit).toEqual([expect.objectContaining({
      id: 1,
      taskType: 'agent',
      scheduledAt: t0,
      result: 'policy-guard',
      reason: 'members',
    })]);
    expect(JSON.stringify(audit)).not.toContain(TASK);
    expect(JSON.stringify(audit)).not.toContain(CHAT);
    expect(JSON.stringify(audit)).not.toContain('ou_victim');
    expect(JSON.stringify(audit)).not.toContain(USER);

    const policyEvents = info.mock.calls.filter((call) => call[0] === 'auto' && call[1] === 'policy-guard');
    expect(policyEvents).toHaveLength(1);
    expect(policyEvents[0]?.[2]).toEqual(expect.objectContaining({
      id: 1,
      fireAt: t0,
      reason: 'members',
    }));
    expect(JSON.stringify(policyEvents)).not.toContain(TASK);
    expect(JSON.stringify(policyEvents)).not.toContain(CHAT);
    expect(JSON.stringify(policyEvents)).not.toContain('ou_victim');
    info.mockRestore();
  });

  it.each([
    ['create chat', 'lark-cli im +chat-create --name extra', 'chat-create'],
    ['member remove', 'lark-cli im chat.members delete --chat-id oc_group --data \'{"id_list":["ou_victim"]}\'', 'members'],
    ['user identity', 'lark-cli im +chat-messages-list --chat-id oc_group --as user', 'user-identity'],
  ] as const)('blocks %s, pauses the task, and audits without leaking ids', async (_label, command, reason) => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const h = await harness({
      nowMs: t0,
      seed: true,
      events: [bashRun(command)],
    });

    await waitFor(() => outboxBodies(h.channel).some((body) => body.includes(POLICY_NOTICE)));
    const status = await waitForStatus(h, (snapshot) => snapshot.items[0]?.paused === true);
    expect(status.items[0]?.paused).toBe(true);
    const audit = await waitForLog(h, (entries) => entries.some((entry) => entry.result === 'policy-guard'));
    expect(audit).toEqual([expect.objectContaining({ id: 1, result: 'policy-guard', reason })]);
    expect(JSON.stringify(audit)).not.toContain(TASK);
    expect(JSON.stringify(audit)).not.toContain(CHAT);
    expect(info.mock.calls.filter((call) => call[0] === 'auto' && call[1] === 'policy-guard')).toHaveLength(1);
    info.mockRestore();
  });

  it('lets allowed reads and same-group sends finish with status ok and an empty policy-guard log', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const h = await harness({
      nowMs: t0,
      seed: true,
      events: [bashRun(
        'lark-cli im +chat-messages-list --chat-id oc_group',
        [
          {
            type: 'tool_use',
            id: 'tool-2',
            name: 'Bash',
            input: { command: 'lark-cli im +messages-send --chat-id oc_group --text already delivered' },
          },
          {
            type: 'tool_result',
            id: 'tool-2',
            output: '{"code":0,"data":{"message_id":"om_sent"}}',
            isError: false,
          },
        ],
      )],
    });

    await waitFor(() =>
      info.mock.calls.some((call) => call[0] === 'outbound' && call[1] === 'skip-cli-already-sent')
      || outboxBodies(h.channel).some((body) => body.includes(FIRE_ONE) || body.includes(FOOTER)),
    );
    const status = await waitForStatus(h, (snapshot) =>
      snapshot.items[0]?.lastFireAt === t0
      && snapshot.items[0]?.paused === false
      && snapshot.items[0]?.lastStatus === 'ok',
    );
    expect(status.items[0]).toEqual(expect.objectContaining({
      id: 1,
      paused: false,
      lastStatus: 'ok',
    }));
    expect(h.store.get(1)?.paused).toBe(false);
    expect(outboxBodies(h.channel).join('\n')).not.toContain(POLICY_NOTICE);
    await expect(h.store.readLog()).resolves.toEqual([]);
    expect(info.mock.calls.filter((call) => call[0] === 'auto' && call[1] === 'policy-guard')).toHaveLength(0);
    expect(h.agent.runOptions[0]?.promptVariant).toBe('automation');
    info.mockRestore();
  });

  it('keeps a human run on the profile identity preset and does not pause the task for --as user in chat', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness({
      nowMs: t0,
      seed: true,
      nextFireAt: t0 + HOUR,
      hold,
      events: [
        [
          { type: 'system', resumeHandle: 'sess-human' },
          {
            type: 'tool_use',
            id: 'h1',
            name: 'Bash',
            input: { command: 'lark-cli im +chat-messages-list --chat-id oc_group --as user' },
          },
          {
            type: 'tool_result',
            id: 'h1',
            output: '{"code":0,"data":{"items":[]}}',
            isError: false,
          },
          { type: 'text', delta: HUMAN },
          { type: 'done', terminationReason: 'normal' },
        ],
        bashRun('lark-cli im +chat-messages-list --chat-id oc_group', [{ type: 'text', delta: FIRE_ONE }]),
      ],
      messageReply: 'text',
    });

    await h.channel.handlers.message?.(mention('om_human', 'please list yesterday'));
    await waitFor(() => h.agent.runs.length === 1);
    expect(h.cfg.larkCli.identityPreset).toBe('user-default');
    expect(h.agent.runOptions[0]?.promptVariant).toBeUndefined();
    expect(h.agent.runOptions[0]?.prompt).toContain('please list yesterday');
    expect(h.agent.runOptions[0]?.prompt).not.toContain(TASK);

    h.setNow(t0 + HOUR);
    await h.bridge.wakeAutomation(formatFireKey(1, t0 + HOUR));
    await waitFor(() => h.agent.runs.length === 2);
    expect(h.agent.runOptions[1]?.promptVariant).toBe('automation');
    expect(h.agent.runOptions[1]?.prompt).toBe(TASK);

    release();
    await waitFor(() =>
      bodies(h.channel).some((body) => body.includes(HUMAN))
      && outboxBodies(h.channel).some((body) => body.includes(FIRE_ONE)),
    );

    const status = await waitForStatus(h, (snapshot) => snapshot.items[0]?.lastFireAt === t0 + HOUR);
    expect(h.cfg.larkCli.identityPreset).toBe('user-default');
    expect(status.items[0]?.paused).toBe(false);
    expect(bodies(h.channel).some((body) => body.includes(HUMAN))).toBe(true);
    expect(outboxBodies(h.channel).join('\n')).not.toContain(POLICY_NOTICE);
    await expect(h.store.readLog()).resolves.toEqual([]);
  });
});

type Recording = ReturnType<typeof createRecordingLarkChannel>;

async function harness(opts: {
  nowMs: number;
  seed?: boolean;
  nextFireAt?: number;
  events?: FakeAgentEvents;
  hold?: Promise<void>;
  messageReply?: 'card' | 'text';
  tmp?: Awaited<ReturnType<typeof createTmpProfile>>;
  store?: AutomationsStore;
} = { nowMs: t0 }) {
  const tmp = opts.tmp ?? await createTmpProfile('auto-safety-');
  let nowMs = opts.nowMs;
  const now = () => nowMs;
  const store = opts.store ?? new AutomationsStore({
    path: join(tmp.profile, 'automations.json'),
    logPath: join(tmp.profile, 'automations.log'),
    statusPath: join(tmp.profile, 'automations-status.json'),
    now,
  });
  if (!opts.store) await store.load();
  if (opts.seed !== false) {
    await store.create({
      taskType: 'agent',
      schedule: hourly,
      timezone: 'UTC',
      startAt: t0,
      endAt: HOURLY_END,
      nextFireAt: opts.nextFireAt ?? t0,
      chatId: CHAT,
      createdBy: USER,
      name: 'issue 汇总',
      taskText: TASK,
      cwd: tmp.workspace,
    });
  }

  const journal = new TurnJournal(join(tmp.profile, 'turn-journal.json'), { now });
  await journal.load();
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], allowedChats: [CHAT] },
    preferences: {
      requireMentionInGroup: true,
      messageReply: opts.messageReply ?? 'card',
      messageReplyMigrated: true,
      cotMessages: 'off',
      showToolCalls: true,
    },
  });
  cfg.automations = { enabled: true, agentTasks: true, timezone: 'UTC' };
  cfg.workspaces.default = tmp.workspace;
  cfg.larkCli = { identityPreset: 'user-default' };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd(CHAT, tmp.workspace);
  const agent = new FakeAgentAdapter({
    id: 'claude',
    events: opts.events ?? [],
    ...(opts.hold ? { hold: opts.hold } : {}),
  });
  const channel = createRecordingLarkChannel({
    chats: [{ id: CHAT, name: 'G' }],
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
      processId: 'test-auto-safety',
    },
  });
  const cleanup = async () => {
    await bridge.disconnect().catch(() => {});
    await store.flush().catch(() => {});
    await journal.flush().catch(() => {});
    await tmp.cleanup();
  };
  cleanups.push(cleanup);
  return {
    channel,
    store,
    journal,
    bridge,
    agent,
    cfg,
    tmp,
    workspace: await realpath(tmp.workspace),
    statusPath: join(tmp.profile, 'automations-status.json'),
    setNow(next: number) {
      nowMs = next;
    },
  };
}

function bashRun(command: string, extra: AgentEvent[] = []): AgentEvent[] {
  return [
    { type: 'system', resumeHandle: 'sess-fire' },
    { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command } },
    {
      type: 'tool_result',
      id: 'tool-1',
      output: '{"code":0,"data":{}}',
      isError: false,
    },
    ...extra,
    { type: 'text', delta: FIRE_ONE },
    { type: 'done', terminationReason: 'normal' },
  ];
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
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Pin Bot', isBot: true }],
    createTime: Date.now(),
  } as unknown as NormalizedMessage;
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

function outboxBodies(channel: Recording): string[] {
  return channel.sent.filter((row) => !isBoardSend(row)).map((row) => {
    const content = row.content as { text?: string; markdown?: string };
    if (typeof content?.text === 'string') return content.text;
    if (typeof content?.markdown === 'string') return content.markdown;
    return JSON.stringify(row.content);
  });
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

async function waitForStatus(
  h: { statusPath: string },
  pred: (status: Awaited<ReturnType<typeof readStatus>>) => boolean,
) {
  let snapshot: Awaited<ReturnType<typeof readStatus>> | undefined;
  await waitFor(async () => {
    try {
      snapshot = await readStatus(h.statusPath);
      return pred(snapshot);
    } catch {
      return false;
    }
  });
  if (!snapshot) throw new Error('expected automations-status.json');
  return snapshot;
}

async function waitForLog(
  h: { store: AutomationsStore },
  pred: (entries: Awaited<ReturnType<AutomationsStore['readLog']>>) => boolean,
) {
  let entries: Awaited<ReturnType<AutomationsStore['readLog']>> = [];
  await waitFor(async () => {
    entries = await h.store.readLog();
    return pred(entries);
  });
  return entries;
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await yieldIO();
  }
  throw new Error('expected automation safety transition was not observed');
}
