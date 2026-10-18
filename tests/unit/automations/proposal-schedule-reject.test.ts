import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import { AutoActionAuth } from '../../../src/automations/action-auth';
import { completeDraftEnd, handleAutoCommand, submitAutomationProposal } from '../../../src/automations/command';
import { AutomationsStore } from '../../../src/automations/store';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import { closeLogger, configureLogger, flushLogger } from '../../../src/core/logger';
import type { CommandContext } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createFakeChannel } from '../../helpers/fake-channel';

const CHAT = 'oc_group';
const USER = 'ou_user';
/** 2026-10-18 15:05 Asia/Shanghai. */
const NOW = Date.UTC(2026, 9, 18, 7, 5, 0);
const LOG_AT = new Date('2026-05-25T12:00:00.000Z');
const TASK = '任务正文甲';
const NAME = '名称甲';

const dirs: string[] = [];

afterEach(async () => {
  await closeLogger();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('proposal schedule acceptance', () => {
  it('turns 今天 HH:MM into a one-shot confirm card', async () => {
    const h = await harness();
    await h.propose('今天 15:50', 'proposal');

    expect(h.store.listDrafts()).toHaveLength(1);
    const draft = h.store.listDrafts()[0]!;
    expect(draft.nextFireAt).toBe(Date.UTC(2026, 9, 18, 7, 50, 0));
    const card = JSON.stringify(draft.cardBody);
    expect(card).toContain('一次性 2026-10-18 15:50');
    expect(markdowns(h.channel)).toEqual([]);
  });

  it('shows the recurring start on the confirm card and does not fire today', async () => {
    const h = await harness();
    await h.propose('从 明天 15:40 起 every 10m 15:40-16:05 until 2026-10-19 16:05', 'proposal');

    const draft = h.store.listDrafts()[0]!;
    expect(draft.startAt).toBe(Date.UTC(2026, 9, 19, 7, 40, 0));
    expect(draft.nextFireAt).toBe(Date.UTC(2026, 9, 19, 7, 40, 0));
    const card = JSON.stringify(draft.cardBody);
    const scheduleAt = card.indexOf('时间表');
    const startLine = card.indexOf('从 2026-10-19 15:40 开始');
    expect(startLine).toBeGreaterThan(scheduleAt);
    expect(card).toContain('2026-10-19 15:40');
    expect(card).not.toContain('2026-10-18 15:40');
  });

  it('logs auto.rejected for a past 今天 time without the task or schedule text', async () => {
    const h = await harness();
    await h.propose('今天 15:00', 'proposal');

    expect(h.store.listDrafts()).toEqual([]);
    expect(markdowns(h.channel)).toEqual(['今天 15:00 已过。例如：明天 15:00']);
    const rejected = await logEvents(h.logsDir, 'rejected');
    expect(rejected).toEqual([
      expect.objectContaining({
        phase: 'auto',
        event: 'rejected',
        reason: 'past-time',
        source: 'proposal',
      }),
    ]);
    const blob = JSON.stringify(rejected);
    expect(blob).not.toContain('今天 15:00');
    expect(blob).not.toContain(TASK);
    expect(blob).not.toContain(NAME);
    expect(blob).not.toContain(CHAT);
    expect(blob).not.toContain(USER);
  });

  it('logs source=command when /auto new fails the same check', async () => {
    const h = await harness();
    await h.command('new 今天 15:12 | 名称甲 | 任务正文甲');

    expect(markdowns(h.channel)).toEqual(['最早 10 分钟后。']);
    const rejected = await logEvents(h.logsDir, 'rejected');
    expect(rejected).toEqual([
      expect.objectContaining({ reason: 'below-floor', source: 'command' }),
    ]);
    expect(JSON.stringify(rejected)).not.toContain('今天 15:12');
    expect(JSON.stringify(rejected)).not.toContain(TASK);
  });

  it('uses distinct replies for a bad start, a start before today, an inverted end, and a start past one year', async () => {
    const h = await harness();
    await h.propose('从 昨天 起 every 10m until 2026-10-19', 'proposal');
    await h.propose('从 2026-10-17 起 every 10m until 2026-10-19', 'proposal');
    await h.propose('从 明天 15:40 起 every 10m 15:40-16:05 until 2026-10-19 15:40', 'proposal');
    await h.propose('从 2027-10-19 起 every 10m until 2027-10-20', 'proposal');

    expect(markdowns(h.channel)).toEqual([
      '无法识别开始时间。例如：从 明天 15:40 起 every 10m 15:40-16:05 until 2026-10-19 16:05',
      '开始时间不能早于今天。',
      '结束时间必须晚于开始时间。',
      '开始时间不能超过 1 年。',
    ]);
    const reasons = (await logEvents(h.logsDir, 'rejected')).map((entry) => entry.reason);
    expect(reasons).toEqual(['invalid-start', 'invalid-start', 'invalid-schedule', 'too-far']);
    expect(h.store.listDrafts()).toEqual([]);
  });

  it('keeps a prefixed start on a draft that is still waiting for an end', async () => {
    const h = await harness();
    await h.propose('从 明天 15:40 起 every 10m 15:40-16:05', 'command');
    const draft = h.store.listDrafts()[0]!;
    expect(draft.startAt).toBe(Date.UTC(2026, 9, 19, 7, 40, 0));
    expect(draft.pendingRecurring?.kind).toBe('interval');
    const rejected = await completeDraftEnd({
      automations: h.store,
      autoAuth: h.autoAuth,
      channel: h.channel as never,
      now: () => NOW,
    }, draft, draft.startAt, 'om_end');
    expect(rejected).toEqual({ ok: false, message: '结束时间必须晚于开始时间。' });
    expect(h.store.listDrafts()[0]?.pendingRecurring?.kind).toBe('interval');
  });
});

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'auto-a23-'));
  dirs.push(dir);
  const logsDir = join(dir, 'logs');
  configureLogger({ logsDir, retentionDays: 1, now: () => LOG_AT });
  const store = new AutomationsStore({
    path: join(dir, 'automations.json'),
    logPath: join(dir, 'automations.log'),
    statusPath: join(dir, 'automations-status.json'),
    now: () => NOW,
  });
  const autoAuth = new AutoActionAuth({
    secret: 'auto-secret',
    nonceStore: new CallbackNonceStore(join(dir, 'nonces.json')),
    now: () => NOW,
  });
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], allowedChats: [CHAT] },
    preferences: { requireMentionInGroup: true, messageReply: 'text', messageReplyMigrated: true },
  });
  cfg.automations = { enabled: true, agentTasks: false, timezone: 'Asia/Shanghai' };
  const channel = createFakeChannel();
  const workspaces = new WorkspaceStore(join(dir, 'workspaces.json'));
  const ctx = {
    channel,
    msg: message('om_user'),
    scope: CHAT,
    chatMode: 'group',
    workspaces,
    controls: {
      profile: 'test',
      profileConfig: cfg,
      cfg,
      ownerRefreshState: 'ok',
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: join(dir, 'config.json'),
      processId: 'test',
    },
    automations: store,
    autoAuth,
    now: () => NOW,
  } as unknown as CommandContext;
  return {
    logsDir,
    store,
    autoAuth,
    channel,
    command: (args: string) => handleAutoCommand(args, ctx),
    propose: (scheduleText: string, source: 'proposal' | 'command') => submitAutomationProposal(ctx, {
      taskType: 'reminder',
      scheduleText,
      name: NAME,
      taskText: TASK,
    }, source),
  };
}

function message(messageId: string): NormalizedMessage {
  return {
    messageId,
    content: '',
    chatId: CHAT,
    chatType: 'group',
    senderId: USER,
    senderName: 'User',
    rawContentType: 'text',
    resources: [],
    mentionedBot: true,
    createTime: NOW,
    raw: { sender: { sender_type: 'user', sender_id: { open_id: USER } } },
  } as unknown as NormalizedMessage;
}

function markdowns(channel: ReturnType<typeof createFakeChannel>): string[] {
  return channel.sent.flatMap((item) => {
    const content = item.content as { markdown?: unknown };
    return typeof content?.markdown === 'string' ? [content.markdown] : [];
  });
}

async function logEvents(logsDir: string, event: string): Promise<Array<Record<string, unknown>>> {
  await flushLogger();
  const key = `${LOG_AT.getFullYear()}${String(LOG_AT.getMonth() + 1).padStart(2, '0')}${String(LOG_AT.getDate()).padStart(2, '0')}`;
  const text = await readFile(join(logsDir, `bridge-${key}.jsonl`), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.event === event);
}
