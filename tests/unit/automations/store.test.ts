import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutomationsStore } from '../../../src/automations/store';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
  ));
});

async function fixture(now = () => 1_760_000_000_000) {
  const dir = await mkdtemp(join(tmpdir(), 'automations-store-'));
  dirs.push(dir);
  const path = join(dir, 'automations.json');
  const logPath = join(dir, 'automations.log');
  const statusPath = join(dir, 'automations-status.json');
  return {
    dir,
    path,
    logPath,
    statusPath,
    store: new AutomationsStore({ path, logPath, statusPath, now }),
  };
}

function reminderInput(overrides: Record<string, unknown> = {}) {
  return {
    taskType: 'reminder' as const,
    schedule: { type: 'one-shot', at: 1_760_000_600_000 },
    timezone: 'Asia/Shanghai',
    startAt: 1_760_000_000_000,
    endAt: 1_760_000_600_000,
    nextFireAt: 1_760_000_600_000,
    chatId: 'oc_group',
    createdBy: 'ou_alice',
    name: '交周报',
    taskText: '提醒交周报',
    ...overrides,
  };
}

describe('AutomationsStore', () => {
  it('treats a missing file as empty and does not create one until an item is recorded', async () => {
    const { path, logPath, statusPath, store } = await fixture();
    await store.load();
    expect(store.list()).toEqual([]);
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await store.flush();
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(statusPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('assigns never-reused monotonic ids across delete and restart (delete 3, create → 4)', async () => {
    const { path, logPath, statusPath, store } = await fixture();
    await store.load();
    const first = await store.create(reminderInput({ name: 'one' }));
    const second = await store.create(reminderInput({ name: 'two' }));
    const third = await store.create(reminderInput({ name: 'three' }));
    expect([first.id, second.id, third.id]).toEqual([1, 2, 3]);

    await store.delete(3);
    expect(store.list().map((item) => item.id)).toEqual([1, 2]);

    const afterDelete = await store.create(reminderInput({ name: 'four' }));
    expect(afterDelete.id).toBe(4);

    const restarted = new AutomationsStore({ path, logPath, statusPath, now: () => 1_760_000_000_000 });
    await restarted.load();
    expect(restarted.list().map((item) => item.id).sort((a, b) => a - b)).toEqual([1, 2, 4]);
    const fifth = await restarted.create(reminderInput({ name: 'five' }));
    expect(fifth.id).toBe(5);
  });

  it('makes markStarted durable before it returns and reports already-started on a second call', async () => {
    const { path, logPath, statusPath, store } = await fixture();
    await store.load();
    const item = await store.create(reminderInput());
    const fireKey = `${item.id}@${item.nextFireAt}`;

    await expect(store.markStarted(fireKey)).resolves.toBe('started');
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as { started: string[] };
    expect(onDisk.started).toEqual([fireKey]);
    expect(store.get(item.id)?.lastFireAt).toBe(item.nextFireAt);
    expect(store.get(item.id)?.lastStatus).toBe('running');

    await expect(store.markStarted(fireKey)).resolves.toBe('already-started');

    const restarted = new AutomationsStore({ path, logPath, statusPath, now: () => 1_760_000_000_000 });
    await restarted.load();
    await expect(restarted.markStarted(fireKey)).resolves.toBe('already-started');
  });

  it('refuses a future schemaVersion without overwriting the original file', async () => {
    const { path, logPath, statusPath, store } = await fixture();
    const future = `${JSON.stringify({
      schemaVersion: 2,
      nextId: 9,
      items: [{ id: 8, taskType: 'reminder', name: 'keep-me' }],
    }, null, 2)}\n`;
    await writeFile(path, future);

    await expect(store.load()).rejects.toThrow(/schemaVersion: 2/);
    expect(await readFile(path, 'utf8')).toBe(future);
    await expect(store.create(reminderInput())).rejects.toBeDefined();
    expect(await readFile(path, 'utf8')).toBe(future);
    await expect(store.flush()).rejects.toBeDefined();
    expect(await readFile(path, 'utf8')).toBe(future);
  });

  it('keeps automations log entries after item deletion, expiry, and fire-history pruning', async () => {
    const now = { t: 1_760_000_000_000 };
    const { path, logPath, statusPath, store } = await fixture(() => now.t);
    await store.load();
    const item = await store.create(reminderInput({
      cwd: undefined,
      nextFireAt: 1_760_000_600_000,
    }));

    await store.recordLog({
      id: item.id,
      taskType: item.taskType,
      scheduledAt: 1_760_000_060_000,
      decidedAt: now.t,
      triggerSource: 'startup',
      result: 'missed',
    });
    await store.recordLog({
      id: item.id,
      taskType: item.taskType,
      scheduledAt: 1_760_000_120_000,
      decidedAt: now.t,
      triggerSource: 'link-recovered',
      result: 'catch-up',
    });

    for (let i = 0; i < 25; i += 1) {
      now.t += 60_000;
      await store.markStarted(`${item.id}@${1_760_000_600_000 + i * 60_000}`);
    }
    expect(store.get(item.id)?.fireHistory).toHaveLength(20);

    const logBytesBeforeExpire = await readFile(logPath, 'utf8');
    await store.expire(item.id);
    expect(store.list()).toEqual([]);
    expect(await readFile(logPath, 'utf8')).toBe(logBytesBeforeExpire);

    const logAfterExpire = await store.readLog();
    expect(logAfterExpire).toEqual([
      {
        id: item.id,
        taskType: 'reminder',
        scheduledAt: 1_760_000_060_000,
        decidedAt: 1_760_000_000_000,
        triggerSource: 'startup',
        result: 'missed',
      },
      {
        id: item.id,
        taskType: 'reminder',
        scheduledAt: 1_760_000_120_000,
        decidedAt: 1_760_000_000_000,
        triggerSource: 'link-recovered',
        result: 'catch-up',
      },
    ]);

    const restarted = new AutomationsStore({ path, logPath, statusPath, now: () => now.t });
    await restarted.load();
    expect(await restarted.readLog()).toEqual(logAfterExpire);
    expect(await readFile(logPath, 'utf8')).toBe(logBytesBeforeExpire);
  });

  it('round-trips a redacted policy-guard automations-log line without a trigger source', async () => {
    const { path, logPath, statusPath, store } = await fixture();
    await store.load();
    const item = await store.create(reminderInput({ taskType: 'agent', cwd: '/work/repo' }));
    await store.recordLog({
      id: item.id,
      taskType: 'agent',
      scheduledAt: item.nextFireAt,
      decidedAt: 1_760_000_000_000,
      result: 'policy-guard',
      reason: 'members',
    });
    const entries = await store.readLog();
    expect(entries).toEqual([{
      id: item.id,
      taskType: 'agent',
      scheduledAt: item.nextFireAt,
      decidedAt: 1_760_000_000_000,
      result: 'policy-guard',
      reason: 'members',
    }]);
    expect(JSON.stringify(entries)).not.toContain('oc_group');
    const restarted = new AutomationsStore({ path, logPath, statusPath });
    await restarted.load();
    expect(await restarted.readLog()).toEqual(entries);
  });

  it('writes a status file and automations log without Feishu ids, secrets, or task text', async () => {
    const { path, logPath, statusPath, store } = await fixture();
    await store.load();
    const item = await store.create(reminderInput({
      chatId: 'oc_secret_chat',
      createdBy: 'ou_alice',
      name: '交周报',
      taskText: 'secret task body',
    }));
    await store.recordLog({
      id: item.id,
      taskType: 'reminder',
      scheduledAt: item.nextFireAt,
      decidedAt: 1_760_000_000_000,
      triggerSource: 'wake',
      result: 'missed',
    });
    await store.writeStatus('Grok Bot');

    const automationsFile = await readFile(path, 'utf8');
    expect(automationsFile).toContain('oc_secret_chat');
    expect(automationsFile).toContain('ou_alice');
    expect(automationsFile).toContain('secret task body');

    const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>;
    expect(status).toEqual({
      v: 1,
      bot: 'Grok Bot',
      updatedAt: 1_760_000_000_000,
      items: [{
        id: 1,
        paused: false,
        nextFireAt: 1_760_000_600_000,
        lastFireAt: 0,
        lastStatus: 'ok',
        endAt: 1_760_000_600_000,
        missed: 0,
      }],
    });
    const statusBytes = await readFile(statusPath, 'utf8');
    const logBytes = await readFile(logPath, 'utf8');
    for (const forbidden of ['oc_secret_chat', 'ou_alice', 'secret task body', 'cli_test', 'APP_SECRET']) {
      expect(statusBytes).not.toContain(forbidden);
      expect(logBytes).not.toContain(forbidden);
    }
  });

  it('drops drafts older than 24 hours and persists remaining drafts', async () => {
    const now = { t: 1_760_000_000_000 };
    const { path, logPath, statusPath, store } = await fixture(() => now.t);
    await store.load();
    const fresh = await store.saveDraft(reminderInput({ name: 'keep' }));
    now.t += 24 * 60 * 60 * 1000 + 1;
    const kept = await store.saveDraft(reminderInput({ name: 'still-fresh' }));
    expect(store.listDrafts().map((draft) => draft.draftId)).toEqual([kept.draftId]);
    expect(store.listDrafts().some((draft) => draft.draftId === fresh.draftId)).toBe(false);

    const restarted = new AutomationsStore({ path, logPath, statusPath, now: () => now.t });
    await restarted.load();
    expect(restarted.listDrafts().map((draft) => draft.name)).toEqual(['still-fresh']);
  });

  it('removeChat drops that chat’s items, drafts and board and leaves other chats', async () => {
    const { store } = await fixture();
    await store.load();
    await store.create(reminderInput({ chatId: 'oc_keep', name: 'keep' }));
    await store.create(reminderInput({ chatId: 'oc_gone', name: 'gone', taskText: 'secret gone body' }));
    await store.saveDraft(reminderInput({ chatId: 'oc_gone', name: 'draft-gone' }));
    await store.saveDraft(reminderInput({ chatId: 'oc_keep', name: 'draft-keep' }));
    await store.setBoard({ chatId: 'oc_gone', messageId: 'om_gone' });
    await store.setBoard({ chatId: 'oc_keep', messageId: 'om_keep' });

    expect(await store.removeChat('oc_gone')).toBe(true);
    expect(store.list().map((item) => item.chatId)).toEqual(['oc_keep']);
    expect(store.listDrafts().map((draft) => draft.chatId)).toEqual(['oc_keep']);
    expect(store.getBoard('oc_gone')).toBeUndefined();
    expect(store.getBoard('oc_keep')?.messageId).toBe('om_keep');
    expect(await store.removeChat('oc_gone')).toBe(false);
  });

  it('persists a per-chat board binding across restart', async () => {
    const { path, logPath, statusPath, store } = await fixture();
    await store.load();
    await store.setBoard({
      chatId: 'oc_group',
      messageId: 'om_board',
      cardId: 'card_1',
      sequence: 2,
    });
    expect(store.getBoard('oc_group')).toEqual({
      chatId: 'oc_group',
      messageId: 'om_board',
      cardId: 'card_1',
      sequence: 2,
    });
    expect(store.findBoardByMessageId('om_board')?.chatId).toBe('oc_group');

    const restarted = new AutomationsStore({ path, logPath, statusPath, now: () => 1_760_000_000_000 });
    await restarted.load();
    expect(restarted.getBoard('oc_group')?.messageId).toBe('om_board');
    expect(restarted.findBoardByMessageId('om_other')).toBeUndefined();
  });

  it('binds a card id onto a draft and takeDraft removes it', async () => {
    const { path, logPath, statusPath, store } = await fixture();
    await store.load();
    const draft = await store.saveDraft(reminderInput({ name: 'bind' }));
    expect(await store.bindDraftCard(draft.draftId, 'om_card')).toBe(true);
    expect(store.getDraft(draft.draftId)?.cardMessageId).toBe('om_card');
    expect(store.findDraftByCardMessageId('om_card')?.draftId).toBe(draft.draftId);
    expect(store.findDraftByCardMessageId('om_other')).toBeUndefined();

    const restarted = new AutomationsStore({ path, logPath, statusPath, now: () => 1_760_000_000_000 });
    await restarted.load();
    expect(restarted.findDraftByCardMessageId('om_card')?.draftId).toBe(draft.draftId);

    const taken = await restarted.takeDraft(draft.draftId);
    expect(taken?.cardMessageId).toBe('om_card');
    expect(restarted.getDraft(draft.draftId)).toBeUndefined();
    expect(await restarted.takeDraft(draft.draftId)).toBeUndefined();
  });

  it('keeps missed instants on the item for 24 hours after they are recorded', async () => {
    const now = { t: 1_760_000_000_000 };
    const { store } = await fixture(() => now.t);
    await store.load();
    const item = await store.create(reminderInput());
    await store.recordMissedInstant(item.id, 1_760_000_100_000);
    now.t += 24 * 60 * 60 * 1000;
    expect(store.get(item.id)?.missedInstants.map((entry) => entry.fireAt)).toEqual([1_760_000_100_000]);
    expect(store.get(item.id)?.missed).toBe(1);
    now.t += 1;
    expect(store.get(item.id)?.missedInstants).toEqual([]);
    expect(store.get(item.id)?.missed).toBe(1);
    await store.recordMissedInstant(item.id, 1_760_000_100_000);
    expect(store.get(item.id)?.missed).toBe(1);
  });

  it('stores agent-task cwd captured at creation', async () => {
    const { store } = await fixture();
    await store.load();
    const item = await store.create(reminderInput({
      taskType: 'agent',
      cwd: '/work/repo',
      name: '汇总',
      taskText: '汇总昨天的 issue',
    }));
    expect(item.cwd).toBe('/work/repo');
    expect(store.get(item.id)?.cwd).toBe('/work/repo');
  });

  it('persists automations files atomically at mode 0o600', async () => {
    const { path, logPath, statusPath, store } = await fixture();
    await store.load();
    await store.create(reminderInput());
    await store.recordLog({
      id: 1,
      taskType: 'reminder',
      scheduledAt: 1,
      decidedAt: 1,
      triggerSource: 'startup',
      result: 'missed',
    });
    await store.writeStatus('bot');
    if (process.platform === 'win32') return;
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    expect((await stat(statusPath)).mode & 0o777).toBe(0o600);
  });
});
