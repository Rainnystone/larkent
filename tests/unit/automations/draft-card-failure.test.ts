import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import { AutoActionAuth } from '../../../src/automations/action-auth';
import { createAutomationBoard } from '../../../src/automations/board';
import { BoardActionAuth } from '../../../src/automations/board-auth';
import { flushPendingDraftCards, handleAutoCommand } from '../../../src/automations/command';
import { AutomationsStore } from '../../../src/automations/store';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import { closeLogger, configureLogger, flushLogger } from '../../../src/core/logger';
import type { CommandContext } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { WorkspaceStore } from '../../../src/workspace/store';
import { CardSchemaError } from '../../helpers/card-schema2';
import { createFakeChannel } from '../../helpers/fake-channel';
import { axiosErrno } from '../../helpers/sdk-feishu-errors';

const CHAT = 'oc_group';
const USER = 'ou_user';
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const LOG_AT = new Date('2026-05-25T12:00:00.000Z');

const dirs: string[] = [];

afterEach(async () => {
  await closeLogger();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('automation draft card delivery', () => {
  it('deletes the draft and replies in text when createCard returns 200610', async () => {
    const h = await harness();
    h.channel.cardErrors.create = new CardSchemaError();
    await h.command('om_bad', 'new in 15m | 交周报 | 提醒交周报');

    expect(h.store.listDrafts()).toEqual([]);
    expect(h.store.list()).toEqual([]);
    const reply = h.channel.sent.find((item) => {
      const content = item.content as { markdown?: unknown };
      return content?.markdown === '确认卡片发送失败（飞书错误 200610），未创建任务。请稍后重试。';
    });
    expect(reply?.options).toMatchObject({ replyTo: 'om_bad' });
    expect(markdowns(h.channel)).toEqual([
      '确认卡片发送失败（飞书错误 200610），未创建任务。请稍后重试。',
    ]);
    const failed = await logEvents(h.logsDir, 'draft.card-failed');
    expect(failed).toEqual([expect.objectContaining({ draftId: expect.any(String), code: 200610 })]);
    const created = await logEvents(h.logsDir, 'fail');
    expect(created.some((entry) => entry.step === 'managed-create' && entry.code === 200610 && entry.msg === 'body is nil')).toBe(true);
  });

  it('keeps the draft when the failure notice hits a link error, then flush delivers the notice', async () => {
    const h = await harness();
    h.channel.cardErrors.create = new CardSchemaError();
    h.channel.sendErrors.send = axiosErrno('ECONNRESET', 'connect ECONNRESET');
    await h.command('om_bad', 'new in 15m | 交周报 | 提醒交周报');

    expect(h.store.listDrafts()).toHaveLength(1);
    expect(h.store.listDrafts()[0]?.cardMessageId).toBeUndefined();
    expect(markdowns(h.channel)).toEqual([]);

    h.channel.cardErrors.create = new CardSchemaError();
    await flushPendingDraftCards({
      channel: h.channel as never,
      automations: h.store,
      autoAuth: h.autoAuth,
      now: () => NOW,
    });
    expect(h.store.listDrafts()).toEqual([]);
    expect(markdowns(h.channel)).toEqual([
      '确认卡片发送失败（飞书错误 200610），未创建任务。请稍后重试。',
    ]);
  });

  it('keeps a draft when create fails with a link error and flush sends the card after recovery', async () => {
    const h = await harness();
    h.channel.cardErrors.create = axiosErrno('ECONNRESET', 'connect ECONNRESET');
    await h.command('om_down', 'new in 15m | 交周报 | 提醒交周报');

    expect(h.store.listDrafts()).toHaveLength(1);
    expect(h.store.listDrafts()[0]?.cardMessageId).toBeUndefined();
    expect(markdowns(h.channel)).toEqual([]);
    expect(await logEvents(h.logsDir, 'draft.card-deferred')).toHaveLength(1);

    await flushPendingDraftCards({
      channel: h.channel as never,
      automations: h.store,
      autoAuth: h.autoAuth,
      now: () => NOW,
    });
    expect(h.store.listDrafts()[0]?.cardMessageId).toBeTruthy();
    expect(JSON.stringify(h.channel.sent)).toContain('auto.confirm');
    expect(markdowns(h.channel)).toEqual([]);
  });

  it('drops a deferred draft instead of posting a card once no fire remains', async () => {
    const h = await harness();
    h.down = true;
    await h.command('om_late', 'new every 10m 11:00-11:20 until 2026-10-17 11:20 | 短窗 | 提醒');
    expect(h.store.listDrafts()).toHaveLength(1);
    expect(h.store.listDrafts()[0]?.cardMessageId).toBeUndefined();

    await flushPendingDraftCards({
      channel: h.channel as never,
      automations: h.store,
      autoAuth: h.autoAuth,
      now: () => Date.UTC(2026, 9, 17, 3, 15, 0),
    });

    expect(h.store.listDrafts()).toEqual([]);
    expect(JSON.stringify(h.channel.sent)).not.toContain('auto.confirm');
    expect(markdowns(h.channel)).toEqual(['结束前已没有可触发的时刻。']);
    const rejected = await logEvents(h.logsDir, 'rejected');
    expect(rejected).toEqual([
      expect.objectContaining({ reason: 'no-remaining-fires', source: 'command' }),
    ]);
    expect(JSON.stringify(rejected)).not.toContain('11:00-11:20');
    expect(JSON.stringify(rejected)).not.toContain('短窗');
  });

  it('keeps flushing the next draft and still refreshes the board when the first create fails', async () => {
    const h = await harness();
    h.down = true;
    await h.command('om_a', 'new in 15m | 甲 | 提醒甲');
    await h.command('om_b', 'new in 20m | 乙 | 提醒乙');
    expect(h.store.listDrafts()).toHaveLength(2);
    const firstId = h.store.listDrafts()[0]!.draftId;
    const secondId = h.store.listDrafts()[1]!.draftId;
    h.down = false;
    h.channel.cardErrors.create = new CardSchemaError();

    await h.store.create({
      taskType: 'reminder',
      schedule: { kind: 'one-shot', fireAt: NOW + 60 * 60_000 },
      timezone: 'Asia/Shanghai',
      startAt: NOW,
      endAt: NOW + 60 * 60_000,
      nextFireAt: NOW + 60 * 60_000,
      chatId: CHAT,
      createdBy: USER,
      name: '已有',
      taskText: '已有任务',
    });
    await h.store.writeStatus('Pin Bot');
    const board = createAutomationBoard({
      store: h.store,
      channel: h.channel as never,
      auth: new BoardActionAuth({ secret: 'board-secret', now: () => NOW }),
      lockPath: join(h.dir, 'board.lock'),
    });
    let refreshed = 0;
    const orig = board.refresh.bind(board);
    board.refresh = () => {
      refreshed += 1;
      return orig();
    };

    await flushPendingDraftCards({
      channel: h.channel as never,
      automations: h.store,
      autoAuth: h.autoAuth,
      now: () => NOW,
    });
    await board.refresh();

    expect(h.store.listDrafts().map((draft) => draft.draftId)).toEqual([secondId]);
    expect(h.store.listDrafts()[0]?.cardMessageId).toBeTruthy();
    expect(firstId).not.toBe(secondId);
    expect(markdowns(h.channel)).toContain('确认卡片发送失败（飞书错误 200610），未创建任务。请稍后重试。');
    expect(JSON.stringify(h.channel.sent)).toContain('auto.confirm');
    expect(JSON.stringify(h.channel.sent)).toContain('本群自动化');
    expect(refreshed).toBe(1);
  });

  it('posts one confirm card when two flushes overlap on the same draft', async () => {
    const h = await harness();
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
    let creates = 0;
    let enteredFirst!: () => void;
    const firstCreate = new Promise<void>(resolve => { enteredFirst = resolve; });
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    h.channel.createCard = async (card) => {
      creates += 1;
      if (creates === 1) { enteredFirst(); await held; }
      return orig(card);
    };
    const flush = () => flushPendingDraftCards({
      channel: h.channel as never,
      automations: h.store,
      autoAuth: h.autoAuth,
      now: () => NOW,
    });

    const first = flush();
    await firstCreate;
    expect(creates).toBe(1);
    const second = flush();
    await Promise.resolve();
    expect(creates).toBe(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(creates).toBe(1);
    expect(h.channel.sent.filter((item) => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
    expect(h.store.listDrafts()[0]?.cardMessageId).toEqual(expect.any(String));
  });
});

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'auto-draft-card-'));
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
  let down = false;
  const command = (messageId: string, args: string) => handleAutoCommand(args, {
    channel: channel as never,
    msg: message(messageId),
    scope: CHAT,
    chatMode: 'group',
    workspaces,
    controls: {
      profile: 'test',
      profileConfig: cfg,
      cfg: cfg as never,
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
    isLinkDown: () => down,
  } as unknown as CommandContext);
  return {
    dir,
    logsDir,
    store,
    autoAuth,
    channel,
    command,
    get down() { return down; },
    set down(next: boolean) { down = next; },
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
