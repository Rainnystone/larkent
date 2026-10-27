import { draftConfirmationDelivery } from '../../../src/automations/draft-confirmation';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import { AutoActionAuth } from '../../../src/automations/action-auth';
import { handleAutoCommand, presetEndAt } from '../../../src/automations/command';
import { flushDraftConfirmations } from '../../../src/automations/draft-confirmation';
import { completeDraftEnd, confirmAutomationDraft } from '../../helpers/draft-confirmation';
import {
  automationDeleteCard,
  automationReplaceCard,
  automationTargetSnapshot,
} from '../../../src/automations/confirm-card';
import { expireDraftConfirmations } from '../../../src/automations/draft-confirmation';
import { createAutomationScheduler } from '../../../src/automations/scheduler';
import {
  AUTOMATIONS_DRAFT_TTL_MS,
  AutomationsStore,
} from '../../../src/automations/store';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import { closeLogger, configureLogger, flushLogger } from '../../../src/core/logger';
import { parseScheduleText } from '../../../src/automations/command';
import type { CommandContext } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { WorkspaceStore } from '../../../src/workspace/store';
import { assertCardSchema2 } from '../../helpers/card-schema2';
import { createFakeChannel } from '../../helpers/fake-channel';
import { axiosErrno } from '../../helpers/sdk-feishu-errors';

const CHAT = 'oc_group';
const USER = 'ou_user';
const OWNER = 'ou_owner_9f3a';
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0);
const FIRE = Date.UTC(2026, 9, 19, 1, 0, 0);
const TZ = 'Asia/Shanghai';
const LOG_AT = new Date('2026-05-25T12:00:00.000Z');

const dirs: string[] = [];

afterEach(async () => {
  await closeLogger();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('delete and replace cards', () => {
  it('renders one delete card and one replace card on the shared confirm tokens', () => {
    const target = {
      id: 12,
      name: '总结马斯克推特',
      taskType: 'reminder' as const,
      scheduleLabel: '一次性 2026-10-19 09:00',
      nextFireLabel: '2026-10-19 09:00',
      endLabel: '一次性',
    };
    const deleted = automationDeleteCard({
      target,
      confirmToken: 'auto_cb.v1.confirm',
      rejectToken: 'auto_cb.v1.reject',
    });
    const deletedJson = JSON.stringify(deleted);
    assertCardSchema2(deleted);
    expect(deletedJson).toContain('确认删除');
    expect(deletedJson).toContain('确认删除 #12 总结马斯克推特？');
    expect(deletedJson).toContain('一次性 2026-10-19 09:00');
    expect(deletedJson).toContain('下次触发');
    expect(deletedJson).toContain('auto.confirm');
    expect(deletedJson).toContain('auto.reject');

    const replaced = automationReplaceCard({
      target,
      taskType: 'reminder',
      name: '马斯克和 Sam',
      taskText: '总结马斯克和 Sam Altman 的推特',
      timezone: TZ,
      schedule: { kind: 'one-shot', fireAt: FIRE },
      now: NOW,
      confirmToken: 'auto_cb.v1.confirm',
      rejectToken: 'auto_cb.v1.reject',
    });
    const replacedJson = JSON.stringify(replaced);
    assertCardSchema2(replaced);
    expect(replacedJson).toContain('确认替换 #12');
    expect(replacedJson).toContain('替换：#12 总结马斯克推特 · 一次性 2026-10-19 09:00 → 新设置如下');
    expect(replacedJson).toContain('确认后原 #12 将由新编号取代');
    expect(replacedJson).not.toContain('将删除');
    expect(replacedJson).toContain('总结马斯克和 Sam Altman 的推特');
    expect(replacedJson).toContain('触发时间：2026-10-19 09:00（共 1 次）');
    expect(replacedJson.match(/"cmd":"auto.confirm"/g)).toHaveLength(1);
  });
});

describe('delete and replace drafts', () => {
  it('keeps an old draft as create, drops an unknown op, and reloads delete and replace cards', async () => {
    const h = await harness();
    const target = {
      id: 12,
      name: '总结马斯克推特',
      taskType: 'reminder' as const,
      scheduleLabel: '一次性 2026-10-19 09:00',
      nextFireLabel: '2026-10-19 09:00',
      endLabel: '一次性',
    };
    const created = await h.store.saveDraft({
      ...reminderInput(),
      op: 'create',
    });
    const deleted = await h.store.saveDraft({
      op: 'delete',
      chatId: CHAT,
      createdBy: USER,
      targetId: 12,
      target,
    });
    const replaced = await h.store.saveDraft({
      ...reminderInput(),
      op: 'replace',
      targetId: 12,
      target,
      scheduleText: '明天 09:00',
    });
    await writeFile(join(h.dir, 'legacy.json'), JSON.stringify({
      schemaVersion: 1,
      nextId: 1,
      items: [],
      started: [],
      boards: [],
      drafts: [
        {
          draftId: 'draft-old',
          createdAt: NOW,
          taskType: 'reminder',
          schedule: { kind: 'one-shot', fireAt: FIRE },
          timezone: TZ,
          startAt: NOW,
          nextFireAt: FIRE,
          chatId: CHAT,
          createdBy: USER,
          name: '旧草稿',
          taskText: '旧任务',
        },
        {
          draftId: 'draft-bad',
          createdAt: NOW,
          op: 'pause',
          taskType: 'reminder',
          schedule: { kind: 'one-shot', fireAt: FIRE },
          timezone: TZ,
          startAt: NOW,
          nextFireAt: FIRE,
          chatId: CHAT,
          createdBy: USER,
          name: '坏草稿',
          taskText: '不能当创建',
        },
      ],
    }));
    const legacy = new AutomationsStore({
      path: join(h.dir, 'legacy.json'),
      logPath: join(h.dir, 'legacy.log'),
      statusPath: join(h.dir, 'legacy-status.json'),
      now: () => NOW,
    });
    await legacy.load();
    expect(legacy.listDrafts().map((draft) => draft.op)).toEqual(['create']);
    expect(legacy.listDrafts()[0]).toMatchObject({ name: '旧草稿', op: 'create' });

    const restarted = new AutomationsStore({
      path: h.store.getFilePath(),
      logPath: join(h.dir, 'automations.log'),
      statusPath: join(h.dir, 'automations-status.json'),
      now: () => NOW,
    });
    await restarted.load();
    expect(restarted.getDraft(created.draftId)?.op).toBe('create');
    expect(restarted.getDraft(deleted.draftId)).toMatchObject({ op: 'delete', targetId: 12 });
    expect(restarted.getDraft(replaced.draftId)).toMatchObject({
      op: 'replace',
      targetId: 12,
      scheduleText: '明天 09:00',
    });
  });

  it('resends the replace card when the confirm send fails after the end is chosen', async () => {
    const h = await harness();
    const item = await h.store.create(reminderInput());
    await savePendingReplace(h, {
      op: 'replace',
      id: item.id,
      taskType: 'reminder',
      scheduleText: '每个工作日 09:00',
      name: '工作日总结',
      taskText: '总结马斯克推特',
    });
    const waiting = scheduleDraft(h.store.listDrafts()[0]);
    expect(waiting.pendingRecurring?.kind).toBe('weekday');
    expect(draftConfirmationDelivery(waiting).messageId).toBeTruthy();
    const endMessageId = draftConfirmationDelivery(waiting).messageId!;

    h.channel.cardErrors.create = axiosErrno('ECONNRESET', 'connect ECONNRESET');
    const chosen = await completeDraftEnd({
      automations: h.store,
      autoAuth: h.autoAuth,
      automationsScheduler: h.scheduler,
      channel: h.channel as never,
      now: () => h.now(),
    }, waiting, presetEndAt('auto.end.1m', TZ, h.now(), waiting.startAt), endMessageId);
    expect(chosen).toEqual({ ok: true });

    const restarted = new AutomationsStore({
      path: h.store.getFilePath(),
      logPath: join(h.dir, 'automations.log'),
      statusPath: join(h.dir, 'automations-status.json'),
      now: () => h.now(),
    });
    await restarted.load();
    const stuck = scheduleDraft(restarted.listDrafts()[0]);
    expect(stuck.pendingRecurring).toBeUndefined();
    expect(draftConfirmationDelivery(stuck).messageId).toBeUndefined();
    expect(stuck.op).toBe('replace');

    h.channel.cardErrors.create = undefined;
    await flushDraftConfirmations({
      channel: h.channel as never,
      automations: restarted,
      autoAuth: h.autoAuth,
      automationsScheduler: h.scheduler,
      now: () => h.now(),
    });
    const recovered = scheduleDraft(restarted.listDrafts()[0]);
    expect(draftConfirmationDelivery(recovered).messageId).toBeTruthy();
    expect(draftConfirmationDelivery(recovered).messageId).not.toBe(endMessageId);
    const cards = h.channel.sent.map((entry) => JSON.stringify(entry.content));
    expect(cards.some((body) => body.includes('确认替换 #') && body.includes('确认后原 #1 将由新编号取代'))).toBe(true);
    expect(h.store.get(item.id)?.name).toBe('总结马斯克推特');
  });

  it('flushes a deferred delete or replace into that card, not a create card', async () => {
    const h = await harness();
    const item = await h.store.create(reminderInput({ name: '总结马斯克推特', taskText: '总结马斯克推特' }));
    const target = automationTargetSnapshot(item);
    await h.store.saveDraft({
      op: 'delete',
      chatId: CHAT,
      createdBy: USER,
      targetId: item.id,
      target,
    });
    await h.store.saveDraft({
      ...reminderInput({ name: '合并后', taskText: '总结马斯克和 Sam Altman 的推特' }),
      op: 'replace',
      targetId: item.id,
      target,
      scheduleText: '2026-10-19 09:00',
    });
    await flushDraftConfirmations({
      channel: h.channel as never,
      automations: h.store,
      autoAuth: h.autoAuth,
      now: () => NOW,
    });
    const cards = h.channel.sent.map((item) => JSON.stringify(item.content));
    expect(cards.some((body) => body.includes('确认删除 #') && body.includes('总结马斯克推特'))).toBe(true);
    expect(cards.some((body) => body.includes('确认替换 #') && body.includes('确认后原 #1 将由新编号取代'))).toBe(true);
    expect(cards.filter((body) => body.includes('确认自动化'))).toHaveLength(0);
    expect(h.store.list()).toHaveLength(1);
  });

  it('settles an expired delete card to 已过期 and keeps the question', async () => {
    const h = await harness();
    const item = await h.store.create(reminderInput());
    await h.store.saveDraft({
      op: 'delete',
      chatId: CHAT,
      createdBy: USER,
      targetId: item.id,
      target: automationTargetSnapshot(item),
    });
    await flushDraftConfirmations({
      channel: h.channel as never,
      automations: h.store,
      autoAuth: h.autoAuth,
      now: () => h.now(),
    });
    expect(draftConfirmationDelivery(h.store.listDrafts()[0]).messageId).toBeTruthy();
    h.setNow(h.now() + AUTOMATIONS_DRAFT_TTL_MS + 1);
    await expireDraftConfirmations({ store: h.store, channel: h.channel as never });
    const settled = h.channel.updatedCards.map((entry) => JSON.stringify(entry.card)).join('\n');
    expect(settled).toContain('已过期');
    expect(settled).toContain('确认删除');
    expect(h.store.listDrafts()).toEqual([]);
    expect(h.store.get(item.id)?.name).toBe('总结马斯克推特');
  });

  it('anchors 一个月 on a start next month', async () => {
    const h = await harness();
    const item = await h.store.create(reminderInput());
    await savePendingReplace(h, {
      op: 'replace',
      id: item.id,
      taskType: 'reminder',
      scheduleText: '从 2026-11-18 起 每个工作日 09:00',
      name: '下月工作日',
      taskText: '总结马斯克推特',
    });
    const waiting = scheduleDraft(h.store.listDrafts()[0]);
    const startAt = Date.UTC(2026, 10, 17, 16, 0, 0);
    expect(waiting.startAt).toBe(startAt);
    const endAt = presetEndAt('auto.end.1m', TZ, h.now(), waiting.startAt);
    expect(endAt).toBe(Date.UTC(2026, 11, 17, 16, 0, 0));
    const chosen = await completeDraftEnd({
      automations: h.store,
      autoAuth: h.autoAuth,
      automationsScheduler: h.scheduler,
      channel: h.channel as never,
      now: () => h.now(),
    }, waiting, endAt, draftConfirmationDelivery(waiting).messageId!);
    expect(chosen).toEqual({ ok: true });
    expect(scheduleDraft(h.store.listDrafts()[0]).endAt).toBe(Date.UTC(2026, 11, 17, 16, 0, 0));
  });

  it('anchors 今年年底 on the year of a start next year', async () => {
    const h = await harness();
    const item = await h.store.create(reminderInput());
    await savePendingReplace(h, {
      op: 'replace',
      id: item.id,
      taskType: 'reminder',
      scheduleText: '从 2027-06-01 起 每天 09:00',
      name: '明年每天',
      taskText: '总结马斯克推特',
    });
    const waiting = scheduleDraft(h.store.listDrafts()[0]);
    const startAt = Date.UTC(2027, 4, 31, 16, 0, 0);
    expect(waiting.startAt).toBe(startAt);
    const endAt = presetEndAt('auto.end.eoy', TZ, h.now(), waiting.startAt);
    expect(endAt).toBe(Date.UTC(2027, 11, 31, 16, 0, 0));
    const chosen = await completeDraftEnd({
      automations: h.store,
      autoAuth: h.autoAuth,
      automationsScheduler: h.scheduler,
      channel: h.channel as never,
      now: () => h.now(),
    }, waiting, endAt, draftConfirmationDelivery(waiting).messageId!);
    expect(chosen).toEqual({ ok: true });
    expect(scheduleDraft(h.store.listDrafts()[0]).endAt).toBe(Date.UTC(2027, 11, 31, 16, 0, 0));
  });

  it('keeps duration presets on now when the task starts immediately', () => {
    expect(presetEndAt('auto.end.1m', TZ, NOW)).toBe(Date.UTC(2026, 10, 17, 3, 0, 0));
    expect(presetEndAt('auto.end.3m', TZ, NOW)).toBe(Date.UTC(2027, 0, 17, 3, 0, 0));
    expect(presetEndAt('auto.end.eoy', TZ, NOW)).toBe(Date.UTC(2026, 11, 31, 16, 0, 0));
    expect(presetEndAt('auto.end.1y', TZ, NOW)).toBe(NOW + 365 * 24 * 60 * 60 * 1000);
    expect(presetEndAt('auto.end.1m', TZ, NOW, NOW)).toBe(Date.UTC(2026, 10, 17, 3, 0, 0));
  });
});

describe('confirming a delete or replace', () => {
  it('deletes on 是, leaves the task on a missing target, and does not check the creator', async () => {
    const h = await harness();
    const item = await h.store.create(reminderInput({ createdBy: OWNER }));
    const draft = await h.store.saveDraft({
      op: 'delete',
      chatId: CHAT,
      createdBy: USER,
      targetId: item.id,
      target: automationTargetSnapshot(item),
    });
    const yes = await confirmAutomationDraft(h.ctx(), draft);
    expect(yes).toEqual({ ok: true, status: `已删除 #${item.id}`, toast: `已删除 #${item.id}` });
    expect(h.store.get(item.id)).toBeUndefined();
    const deleted = await logEvents(h.logsDir, 'deleted');
    expect(deleted).toEqual([expect.objectContaining({ id: item.id, source: 'confirmation' })]);
    expect(JSON.stringify(deleted)).not.toContain(OWNER);
    expect(JSON.stringify(deleted)).not.toContain('总结马斯克推特');

    const gone = await h.store.saveDraft({
      op: 'delete',
      chatId: CHAT,
      createdBy: USER,
      targetId: 99,
      target: { ...automationTargetSnapshot(item), id: 99 },
    });
    const missing = await confirmAutomationDraft(h.ctx(), gone);
    expect(missing).toEqual({ ok: false, status: '#99 已不存在', toast: '#99 已不存在' });
  });

  it('confirms a replace whose fire is still ahead but inside the ten-minute floor', async () => {
    const h = await harness();
    const item = await h.store.create(reminderInput());
    const soon = NOW + 5 * 60_000;
    const draft = await h.store.saveDraft({
      ...reminderInput({
        name: '五分钟后',
        taskText: '五分钟后',
        schedule: { kind: 'one-shot', fireAt: soon },
        nextFireAt: soon,
      }),
      op: 'replace',
      targetId: item.id,
      target: automationTargetSnapshot(item),
      scheduleText: '今天 11:05',
    });
    const result = await confirmAutomationDraft(h.ctx(), draft);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(`已替换 #${item.id} → #${item.id + 1}`);
    expect(h.store.get(item.id)).toBeUndefined();
    expect(h.store.get(item.id + 1)?.nextFireAt).toBe(soon);
  });

  it('reports past-time at confirm and changes nothing', async () => {
    const h = await harness();
    const item = await h.store.create(reminderInput());
    const pastAt = NOW + 15 * 60_000;
    const draft = await h.store.saveDraft({
      ...reminderInput({
        name: '过点',
        taskText: '过点',
        schedule: { kind: 'one-shot', fireAt: pastAt },
        nextFireAt: pastAt,
      }),
      op: 'replace',
      targetId: item.id,
      target: automationTargetSnapshot(item),
      scheduleText: '今天 11:15',
    });
    await flushDraftConfirmations({ ...h.ctx(), channel: h.channel as never, autoAuth: h.autoAuth }, draft.draftId);
    const result = await confirmAutomationDraft({ ...h.ctx(), now: () => NOW + 16 * 60_000 }, draft);
    expect(result.ok).toBe(false);
    expect(result.status).toContain('已过');
    expect(h.store.get(item.id)?.name).toBe('总结马斯克推特');
    expect(h.store.list()).toHaveLength(1);
    const rejected = await logEvents(h.logsDir, 'rejected');
    expect(rejected).toEqual([expect.objectContaining({ reason: 'past-time', source: 'confirmation' })]);
    expect(JSON.stringify(rejected)).not.toContain('今天 11:15');
  });

  it('still deletes immediately from /auto delete', async () => {
    const h = await harness();
    const item = await h.store.create(reminderInput());
    await h.command(`delete ${item.id}`);
    expect(h.store.list()).toEqual([]);
    expect(JSON.stringify(h.channel.sent)).not.toContain('auto.confirm');
    expect(JSON.stringify(h.channel.sent)).toContain(`已删除 #${item.id}`);
    const deleted = await logEvents(h.logsDir, 'deleted');
    expect(deleted).toEqual([expect.objectContaining({ id: item.id })]);
    expect(deleted[0]?.source).toBeUndefined();
  });
});

function scheduleDraft(draft: ReturnType<AutomationsStore['listDrafts']>[number] | undefined) {
  if (!draft || draft.op === 'delete') throw new Error('expected a schedule draft');
  return draft;
}

function reminderInput(overrides: Record<string, unknown> = {}) {
  return {
    taskType: 'reminder' as const,
    schedule: { kind: 'one-shot' as const, fireAt: FIRE },
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

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'auto-a28-'));
  dirs.push(dir);
  const logsDir = join(dir, 'logs');
  configureLogger({ logsDir, retentionDays: 1, now: () => LOG_AT });
  let nowMs = NOW;
  const store = new AutomationsStore({
    path: join(dir, 'automations.json'),
    logPath: join(dir, 'automations.log'),
    statusPath: join(dir, 'automations-status.json'),
    now: () => nowMs,
  });
  await store.load();
  const autoAuth = new AutoActionAuth({
    secret: 'auto-secret',
    nonceStore: new CallbackNonceStore(join(dir, 'nonces.json')),
    now: () => nowMs,
  });
  const channel = createFakeChannel();
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: [USER], allowedChats: [CHAT] },
    preferences: { requireMentionInGroup: true, messageReply: 'text', messageReplyMigrated: true },
  });
  cfg.automations = { enabled: true, agentTasks: false, timezone: TZ };
  const workspaces = new WorkspaceStore(join(dir, 'workspaces.json'));
  const scheduler = createAutomationScheduler({
    store,
    sender: { send() {} },
    notifier: { notify() {} },
    botDisplayName: () => 'Pin Bot',
    now: () => nowMs,
    isLinkUp: () => true,
    enabled: () => true,
  });
  const command = (args: string) => handleAutoCommand(args, {
    channel: channel as never,
    msg: {
      messageId: 'om_cmd',
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
    } as unknown as NormalizedMessage,
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
    automationsScheduler: scheduler,
    now: () => nowMs,
  } as unknown as CommandContext);
  return {
    dir,
    logsDir,
    store,
    autoAuth,
    channel,
    command,
    now: () => nowMs,
    setNow(next: number) {
      nowMs = next;
    },
    scheduler,
    ctx: () => ({
      automations: store,
      automationsScheduler: scheduler,
      now: () => nowMs,
    }),
    proposalCtx: () => ({
      channel: channel as never,
      msg: {
        messageId: 'om_cmd',
        content: '',
        chatId: CHAT,
        chatType: 'group' as const,
        senderId: USER,
        senderName: 'User',
        rawContentType: 'text',
        resources: [],
        mentionedBot: true,
        createTime: NOW,
        raw: { sender: { sender_type: 'user', sender_id: { open_id: USER } } },
      } as unknown as NormalizedMessage,
      scope: CHAT,
      chatMode: 'group' as const,
      workspaces,
      automations: store,
      autoAuth,
      automationsScheduler: scheduler,
      now: () => nowMs,
      controls: {
        profile: 'test',
        profileConfig: cfg,
        cfg: cfg as never,
        ownerRefreshState: 'ok' as const,
        async refreshOwner() {},
        async restart() {},
        async exit() {},
        configPath: join(dir, 'config.json'),
        processId: 'test',
      },
    }),
  };
}

async function logEvents(logsDir: string, event: string): Promise<Array<Record<string, unknown>>> {
  await flushLogger();
  const key = `${LOG_AT.getFullYear()}${String(LOG_AT.getMonth() + 1).padStart(2, '0')}${String(LOG_AT.getDate()).padStart(2, '0')}`;
  const text = await readFile(join(logsDir, `bridge-${key}.jsonl`), 'utf8');
  return text.trim().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === event);
}

async function savePendingReplace(h: Awaited<ReturnType<typeof harness>>, input: {
  op: 'replace'; id: number; taskType: 'reminder'; scheduleText: string; name: string; taskText: string;
}): Promise<void> {
  const parsed = parseScheduleText(input.scheduleText, { taskType: input.taskType, now: h.now(), timezone: TZ });
  if (parsed.ok || parsed.reason !== 'missing-end-at' || !parsed.pending) throw new Error('expected unfinished fixture schedule');
  await h.store.saveDraft({ op: 'replace', targetId: input.id, target: automationTargetSnapshot(h.store.get(input.id)!),
    taskType: input.taskType, scheduleText: input.scheduleText, name: input.name, taskText: input.taskText,
    schedule: parsed.pending, pendingRecurring: parsed.pending, timezone: TZ, startAt: parsed.startAt ?? h.now(), nextFireAt: 0, chatId: CHAT, createdBy: USER });
  await flushDraftConfirmations({ channel: h.channel as never, automations: h.store, autoAuth: h.autoAuth, automationsScheduler: h.scheduler, now: h.now });
}
