import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
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
const LATER = Date.UTC(2026, 9, 17, 8, 0, 0);
const LOG_AT = new Date(Date.UTC(2026, 4, 25, 3, 0, 0));
const VISIBLE = '好的，请点确认卡上的「是」。';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  sdk.channel = undefined;
});

describe('A28 natural-language delete and replace', () => {
  it('injects this chat’s confirmed tasks and leaves drafts, other chats, and open ids out', async () => {
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
    const block = snapshotBlock(h.agent.runOptions[0]?.prompt ?? '');
    expect(block).toContain('group_automations');
    expect(block).toContain('#1 · 提醒 · 总结马斯克推特');
    expect(block).toContain('待触发');
    expect(block).toContain('结束 一次性');
    expect(block).not.toContain('别的群');
    expect(block).not.toContain('未确认草稿');
    expect(block).not.toContain(OWNER);
    expect(block).not.toContain('ou_');
    expect(block).not.toContain('(你创建)');
  }, 15_000);

  it('says the chat has no tasks when the list is empty', async () => {
    const h = await harness({ events: done('看看。') });
    await h.channel.handlers.message?.(mention('om_empty', '有任务吗'));
    await waitFor(() => h.agent.runOptions.length === 1);
    const block = snapshotBlock(h.agent.runOptions[0]?.prompt ?? '');
    expect(block).toContain('本群暂无自动化任务');
    expect(block).toContain('group_automations');
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

  it('lists the whole chat inside a topic thread', async () => {
    const h = await harness({
      events: done('话题里也能看到。'),
      items: [item({ name: '总结马斯克推特', taskText: '总结马斯克推特' })],
    });
    await h.channel.handlers.message?.(mention('om_topic', '本群有哪些任务', { threadId: 'omt_topic' }));
    await waitFor(() => h.agent.runOptions.length === 1);
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('omt_topic');
    expect(snapshotBlock(prompt)).toContain('#1 · 提醒 · 总结马斯克推特');
  }, 15_000);

  it('deletes on 是 for someone who did not create the task, refreshes the board, and keeps the question', async () => {
    const h = await harness({
      events: done(proposal({ op: 'delete', id: 1 })),
      items: [item({ name: '总结马斯克推特', taskText: '总结马斯克推特', createdBy: OWNER })],
    });
    await waitFor(() => boardText(h).includes('总结马斯克推特'));
    await h.channel.handlers.message?.(mention('om_del', '把明天总结推特的那个取消掉', { senderId: MATE }));
    await waitFor(() => sentText(h).includes('auto.confirm') && sentText(h).includes('确认删除'));

    const reply = lastMarkdown(h);
    expect(reply.endsWith('已生成确认卡，点「是」后删除 #1。')).toBe(true);
    expect(reply).not.toContain('已删除');
    const card = cardText(h, '确认删除');
    expect(card).toContain('确认删除 #1 总结马斯克推特');
    expect(card).toContain('一次性 2026-10-19 09:00');
    expect(card).toContain('下次');
    expect(h.store.get(1)?.name).toBe('总结马斯克推特');

    const draft = h.store.listDrafts()[0];
    const tap = await h.channel.handlers.cardAction?.(cardClick(
      MATE,
      token(card, 'auto.confirm'),
      draft!.cardMessageId!,
    ));
    expect(tap).toEqual({ toast: { type: 'success', content: '已删除 #1' } });
    expect(h.store.list()).toEqual([]);
    await waitFor(() => boardText(h).includes('暂无'));
    const settled = updatedCardText(h, '确认删除');
    expect(settled).toContain('确认删除 #1 总结马斯克推特');
    expect(settled).toContain('已删除 #1');
    expect(settled).not.toContain(MATE);
    const deleted = await logEvents(h.logsDir, 'deleted');
    expect(deleted).toEqual([expect.objectContaining({ id: 1, source: 'proposal' })]);
  }, 15_000);

  it('leaves the task in place when the card is rejected', async () => {
    const h = await harness({
      events: done(proposal({ op: 'delete', id: 1 })),
      items: [item()],
    });
    await h.channel.handlers.message?.(mention('om_no', '取消那个提醒'));
    await waitFor(() => sentText(h).includes('确认删除'));
    const draft = h.store.listDrafts()[0];
    const card = cardText(h, '确认删除');
    const tap = await h.channel.handlers.cardAction?.(cardClick(
      USER,
      token(card, 'auto.reject'),
      draft!.cardMessageId!,
      'auto.reject',
    ));
    expect(tap).toEqual({ toast: { type: 'success', content: '已取消' } });
    expect(h.store.get(1)?.name).toBe('总结马斯克推特');
    await waitFor(() => updatedCards(h).some((card) => card.includes('确认删除') && card.includes('已取消')));
  }, 15_000);

  it('uses one sentence for a missing id and for another chat, and does not post a card', async () => {
    const h = await harness({
      events: [
        done(proposal({ op: 'delete', id: 99 })),
        done(proposal({ op: 'delete', id: 2 })),
      ],
      items: [
        item(),
        item({ chatId: OTHER, name: '别的群', taskText: '别的群' }),
      ],
    });
    await h.channel.handlers.message?.(mention('om_missing', '删掉 99'));
    await waitFor(() => lastMarkdown(h).includes('没有删除任务：本群没有 #99。'));
    expect(sentText(h)).not.toContain('auto.confirm');
    expect(h.store.listDrafts()).toEqual([]);

    await h.channel.handlers.message?.(mention('om_other', '删掉另一个群的'));
    await waitFor(() => lastMarkdown(h).includes('没有删除任务：本群没有 #2。'));
    expect(sentText(h)).not.toContain('确认删除');
    expect(h.store.get(2)?.chatId).toBe(OTHER);
    const rejected = await logEvents(h.logsDir, 'rejected');
    expect(rejected).toEqual([
      expect.objectContaining({ reason: 'unknown-id', source: 'proposal', id: 99 }),
      expect.objectContaining({ reason: 'unknown-id', source: 'proposal', id: 2 }),
    ]);
    expect(JSON.stringify(rejected)).not.toContain('总结马斯克推特');
  }, 15_000);

  it('reports a target that disappeared before the tap', async () => {
    const h = await harness({
      events: done(proposal({ op: 'delete', id: 1 })),
      items: [item()],
    });
    await h.channel.handlers.message?.(mention('om_gone', '取消那个提醒'));
    await waitFor(() => h.store.listDrafts()[0]?.cardMessageId !== undefined);
    await h.store.delete(1);
    const draft = h.store.listDrafts()[0];
    const tap = await h.channel.handlers.cardAction?.(cardClick(
      USER,
      token(cardText(h, '确认删除'), 'auto.confirm'),
      draft!.cardMessageId!,
    ));
    expect(tap).toEqual({ toast: { type: 'error', content: '#1 已不存在' } });
    await waitFor(() => updatedCards(h).some((card) => card.includes('确认删除') && card.includes('#1 已不存在')));
  }, 15_000);

  it('lets only one of two simultaneous taps delete the task', async () => {
    const h = await harness({
      events: done(proposal({ op: 'delete', id: 1 })),
      items: [item()],
    });
    await h.channel.handlers.message?.(mention('om_race', '取消那个提醒'));
    await waitFor(() => h.store.listDrafts()[0]?.cardMessageId !== undefined);
    const draft = h.store.listDrafts()[0]!;
    const click = cardClick(MATE, token(cardText(h, '确认删除'), 'auto.confirm'), draft.cardMessageId!);
    const [first, second] = await Promise.all([
      h.channel.handlers.cardAction?.(click),
      h.channel.handlers.cardAction?.(click),
    ]);
    const toasts = [first, second].map((result) => JSON.stringify(result));
    expect(toasts.filter((text) => text.includes('已删除 #1'))).toHaveLength(1);
    expect(toasts.filter((text) => text.includes('此确认已失效'))).toHaveLength(1);
    expect(h.store.list()).toEqual([]);
  }, 15_000);

  it('ignores a delete proposal from an app sender', async () => {
    const h = await harness({
      events: done(proposal({ op: 'delete', id: 1 })),
      items: [item()],
    });
    await h.channel.handlers.message?.(mention('om_bot', '取消那个提醒', {
      senderId: 'ou_app_sender',
      senderType: 'app',
    }));
    await waitFor(() => markdowns(h).some((text) => text.includes(VISIBLE)));
    expect(sentText(h)).not.toContain('auto.confirm');
    expect(h.store.listDrafts()).toEqual([]);
    expect(h.store.get(1)).toBeDefined();
    const ignored = await logEvents(h.logsDir, 'proposal-ignored');
    expect(ignored.length).toBeGreaterThan(0);
  }, 15_000);

  it('replaces by creating the new task before deleting the old one', async () => {
    const h = await harness({
      events: done(proposal({
        op: 'replace',
        id: 1,
        taskType: 'reminder',
        schedule: '2026-10-19 09:00',
        name: '马斯克和 Sam Altman',
        taskText: '总结马斯克和 Sam Altman 的推特',
      })),
      items: [item()],
    });
    await h.channel.handlers.message?.(mention('om_rep', '删了重建，加上 Sam Altman'));
    await waitFor(() => sentText(h).includes('确认替换 #1'));
    expect(lastMarkdown(h).endsWith('已生成确认卡，点「是」后用新任务替换 #1。')).toBe(true);
    const cards = h.channel.sent.filter((entry) => JSON.stringify(entry.content).includes('确认替换 #1'));
    expect(cards).toHaveLength(1);
    const card = JSON.stringify(cards[0]?.content);
    expect(card).toContain('将删除：#1 总结马斯克推特');
    expect(card).toContain('总结马斯克和 Sam Altman 的推特');
    expect(card).not.toContain('确认自动化');
    expect(h.store.list()).toHaveLength(1);

    const draft = h.store.listDrafts()[0];
    const tap = await h.channel.handlers.cardAction?.(cardClick(
      USER,
      token(card, 'auto.confirm'),
      draft!.cardMessageId!,
    ));
    expect(tap).toEqual({ toast: { type: 'success', content: '已替换 #1 → #2' } });
    expect(h.store.get(1)).toBeUndefined();
    expect(h.store.get(2)).toMatchObject({
      name: '马斯克和 Sam Altman',
      taskText: '总结马斯克和 Sam Altman 的推特',
      chatId: CHAT,
    });
    const replaced = await logEvents(h.logsDir, 'replaced');
    expect(replaced).toEqual([expect.objectContaining({ oldId: 1, newId: 2 })]);
    expect(JSON.stringify(replaced)).not.toContain('Sam Altman');
  }, 15_000);

  it('asks for an end first and then posts a replace card', async () => {
    const h = await harness({
      events: done(proposal({
        op: 'replace',
        id: 1,
        taskType: 'reminder',
        schedule: '每个工作日 09:00',
        name: '工作日总结',
        taskText: '总结马斯克推特',
      })),
      items: [item()],
    });
    await h.channel.handlers.message?.(mention('om_end', '改成每个工作日'));
    await waitFor(() => sentText(h).includes('auto.end.1m'));
    expect(sentText(h)).not.toContain('确认替换');
    const pending = h.store.listDrafts()[0];
    expect(pending).toMatchObject({ op: 'replace', targetId: 1 });
    const endCard = cardText(h, 'auto.end.1m');
    const tap = await h.channel.handlers.cardAction?.(cardClick(
      USER,
      token(endCard, 'auto.end.1m'),
      pending!.cardMessageId!,
      'auto.end.1m',
    ));
    expect(JSON.stringify(tap)).toContain('已指定结束时间');
    await waitFor(() => sentText(h).includes('确认替换 #1'));
    const replaceCard = cardText(h, '确认替换 #1');
    expect(replaceCard).toContain('将删除：#1 总结马斯克推特');
    expect(replaceCard).not.toContain('确认自动化');
    expect(h.store.get(1)).toBeDefined();
    const replaceDraft = h.store.listDrafts()[0];
    expect(replaceDraft).toMatchObject({ op: 'replace', targetId: 1 });
    const confirm = await h.channel.handlers.cardAction?.(cardClick(
      USER,
      token(replaceCard, 'auto.confirm'),
      replaceDraft!.cardMessageId!,
    ));
    expect(JSON.stringify(confirm)).toContain('已替换 #1 →');
    expect(h.store.get(1)).toBeUndefined();
    expect(h.store.list().some((entry) => entry.name === '工作日总结')).toBe(true);
  }, 15_000);

  it('reports past-time at confirm and leaves the old task', async () => {
    const h = await harness({
      events: done(proposal({
        op: 'replace',
        id: 1,
        taskType: 'reminder',
        schedule: '今天 15:50',
        name: '过点',
        taskText: '过点',
      })),
      items: [item()],
    });
    await h.channel.handlers.message?.(mention('om_past', '改成今天下午'));
    await waitFor(() => sentText(h).includes('确认替换 #1'));
    h.setNow(LATER);
    const draft = h.store.listDrafts()[0];
    const tap = await h.channel.handlers.cardAction?.(cardClick(
      USER,
      token(cardText(h, '确认替换 #1'), 'auto.confirm'),
      draft!.cardMessageId!,
    ));
    expect(JSON.stringify(tap)).toContain('已过');
    expect(h.store.list()).toHaveLength(1);
    expect(h.store.get(1)?.name).toBe('总结马斯克推特');
    const rejected = await logEvents(h.logsDir, 'rejected');
    expect(rejected).toEqual([expect.objectContaining({ reason: 'past-time', source: 'proposal' })]);
    expect(JSON.stringify(rejected)).not.toContain('今天 15:50');
  }, 15_000);

  it('allows deleting an agent task, refuses replacing one with an agent task, and allows the other direction', async () => {
    const h = await harness({
      events: [
        done(proposal({ op: 'delete', id: 1 })),
        done(proposal({
          op: 'replace',
          id: 2,
          taskType: 'agent',
          schedule: '2026-10-19 09:00',
          name: '代理',
          taskText: '跑代理',
        })),
        done(proposal({
          op: 'replace',
          id: 2,
          taskType: 'reminder',
          schedule: '2026-10-19 09:00',
          name: '改成提醒',
          taskText: '改成提醒',
        })),
      ],
      items: [
        item({ taskType: 'agent', cwd: '/tmp/agent-task', name: '代理任务', taskText: '跑一下' }),
        item({ taskType: 'agent', cwd: '/tmp/agent-task', name: '保留的代理', taskText: '先留着' }),
      ],
    });
    await h.channel.handlers.message?.(mention('om_agent_del', '删掉代理任务'));
    await waitFor(() => sentText(h).includes('确认删除 #1'));
    const deleteDraft = h.store.listDrafts()[0];
    await h.channel.handlers.cardAction?.(cardClick(
      MATE,
      token(cardText(h, '确认删除 #1'), 'auto.confirm'),
      deleteDraft!.cardMessageId!,
    ));
    expect(h.store.get(1)).toBeUndefined();

    await h.channel.handlers.message?.(mention('om_agent_no', '把保留的代理改成 agent'));
    await waitFor(() => lastMarkdown(h).includes('没有替换任务：agent 任务未开启。'));
    expect(h.store.get(2)?.taskType).toBe('agent');
    expect(h.store.listDrafts().some((draft) => draft.op === 'replace')).toBe(false);

    await h.channel.handlers.message?.(mention('om_agent_yes', '把保留的代理改成提醒'));
    await waitFor(() => sentText(h).includes('确认替换 #2'));
    const replaceDraft = h.store.listDrafts().find((draft) => draft.op === 'replace');
    const tap = await h.channel.handlers.cardAction?.(cardClick(
      USER,
      token(cardText(h, '确认替换 #2'), 'auto.confirm'),
      replaceDraft!.cardMessageId!,
    ));
    expect(JSON.stringify(tap)).toContain('已替换 #2 →');
    expect(h.store.get(2)).toBeUndefined();
    expect(h.store.list().some((entry) => entry.taskType === 'reminder' && entry.name === '改成提醒')).toBe(true);
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

function proposal(fields: Record<string, unknown>): string {
  return `${VISIBLE}\n<automation_proposal>\n${JSON.stringify(fields)}\n</automation_proposal>`;
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
    channel,
    store,
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

function snapshotBlock(prompt: string): string {
  const start = prompt.indexOf('本群当前自动化任务');
  const end = prompt.indexOf('/group_automations');
  expect(start, 'expected a group task snapshot').toBeGreaterThanOrEqual(0);
  expect(end, 'expected a snapshot closer').toBeGreaterThan(start);
  return prompt.slice(start, end);
}

function sentText(h: { channel: ReturnType<typeof createRecordingLarkChannel> }): string {
  return JSON.stringify(h.channel.sent);
}

function markdowns(h: { channel: ReturnType<typeof createRecordingLarkChannel> }): string[] {
  return h.channel.sent.flatMap((item) => {
    const content = item.content as { markdown?: unknown };
    return typeof content?.markdown === 'string' ? [content.markdown] : [];
  });
}

function lastMarkdown(h: { channel: ReturnType<typeof createRecordingLarkChannel> }): string {
  return markdowns(h).at(-1) ?? '';
}

function cardText(
  h: { channel: ReturnType<typeof createRecordingLarkChannel> },
  needle: string,
): string {
  const send = [...h.channel.sent].reverse().find((item) => JSON.stringify(item.content).includes(needle));
  expect(send, `expected a card containing ${needle}`).toBeDefined();
  return JSON.stringify(send?.content);
}

function token(cardJson: string, cmd: string): string {
  const match = cardJson.match(new RegExp(`"cmd":"${cmd.replace(/\./g, '\\.')}","auto_token":"(auto_cb\\.v1\\.[^"]+)"`));
  expect(match?.[1], `expected ${cmd} token`).toBeDefined();
  return match![1]!;
}

function cardClick(
  operatorId: string,
  autoToken: string,
  messageId: string,
  cmd = 'auto.confirm',
): CardActionEvent {
  return {
    action: { value: { cmd, auto_token: autoToken } },
    chatId: CHAT,
    messageId,
    operator: { openId: operatorId, name: 'Op' },
  } as unknown as CardActionEvent;
}

function updatedCards(h: { channel: ReturnType<typeof createRecordingLarkChannel> }): string[] {
  return h.channel.updatedCards.map((item) => JSON.stringify(item.card));
}

function updatedCardText(
  h: { channel: ReturnType<typeof createRecordingLarkChannel> },
  needle: string,
): string {
  const updated = [...h.channel.updatedCards].reverse().find((item) => JSON.stringify(item.card).includes(needle));
  expect(updated, `expected an updated card containing ${needle}`).toBeDefined();
  return JSON.stringify(updated?.card);
}

function boardText(h: { channel: ReturnType<typeof createRecordingLarkChannel> }): string {
  const updated = [...h.channel.updatedCards].reverse().find((item) => (
    JSON.stringify(item.card).includes('本群自动化')
  ));
  if (updated) return JSON.stringify(updated.card);
  const send = [...h.channel.sent].reverse().find((item) => JSON.stringify(item.content).includes('本群自动化'));
  return JSON.stringify(send?.content ?? '');
}

async function logEvents(logsDir: string, event: string): Promise<Array<Record<string, unknown>>> {
  await flushLogger();
  const key = `${LOG_AT.getFullYear()}${String(LOG_AT.getMonth() + 1).padStart(2, '0')}${String(LOG_AT.getDate()).padStart(2, '0')}`;
  const text = await readFile(join(logsDir, `bridge-${key}.jsonl`), 'utf8');
  return text.trim().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === event);
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
