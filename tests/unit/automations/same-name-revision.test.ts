import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { confirmAutomationDraft } from '../../../src/automations/draft-confirmation';
import { automationOperationScope, newAutomationOperationId } from '../../../src/automations/operation-id';
import { AUTOMATIONS_SCHEMA_VERSION, AutomationsStore } from '../../../src/automations/store';

const SAME_NAME_TOAST = '已有同名任务 #1，此确认已失效';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const PROFILE = 'synthetic';
const CHAT = 'oc_synthetic';
const OTHER_CHAT = 'oc_other';
const ACTOR = 'ou_synthetic';
const MATE = 'ou_mate';
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it('auto-supersedes a same-name pending create without supersedesOperationId', async () => {
  const { store } = await storeAt(NOW);
  const nine = await saveReminder(store, { name: 'Daily regression', hour: 9, operationId: operationId(NOW) });
  const revised = await saveReminder(store, { name: ' Daily regression ', hour: 8, minute: 45, operationId: operationId(NOW + 1) });
  expect(store.getOperation(nine.operationId!)).toMatchObject({ state: 'not-applied', code: 'draft-superseded' });
  expect(store.getDraft(nine.draftId)).toBeUndefined();
  expect(store.getOperation(revised.operationId!)).toMatchObject({
    state: 'received',
    supersedesOperationId: nine.operationId,
  });
  expect(store.listDrafts()).toEqual([expect.objectContaining({ draftId: revised.draftId })]);
  expect(createDraftName(store.listDrafts()[0])).toBe('Daily regression');
});

it('does not supersede another actor, chat, or different name', async () => {
  const { store } = await storeAt(NOW);
  const original = await saveReminder(store, { name: 'Daily regression', hour: 9, operationId: operationId(NOW) });
  const otherActor = await saveReminder(store, {
    name: 'Daily regression', hour: 8, minute: 45, createdBy: MATE, operationId: operationId(NOW + 1),
  });
  const otherChat = await saveReminder(store, {
    name: 'Daily regression', hour: 8, minute: 45, chatId: OTHER_CHAT, profile: PROFILE,
    operationId: newAutomationOperationId(automationOperationScope(PROFILE, OTHER_CHAT), NOW + 2),
  });
  const otherName = await saveReminder(store, {
    name: 'Evening regression', hour: 8, minute: 45, operationId: operationId(NOW + 3),
  });
  for (const draft of [original, otherActor, otherChat, otherName]) {
    expect(store.getOperation(draft.operationId!)).toMatchObject({ state: 'received' });
    expect(store.getDraft(draft.draftId)).toBeDefined();
  }
  expect(store.listDrafts()).toHaveLength(4);
});

it('rejects confirming a leftover same-name twin after the later draft was applied', async () => {
  const store = await leftoverTwins();
  const [first, second] = store.listDrafts();
  expect(createDraftName(first)).toBe('Daily regression');
  expect(createDraftName(second)).toBe('Daily regression');
  const applied = await confirmAutomationDraft({ automations: store }, second!);
  expect(applied).toMatchObject({ ok: true, toast: '已确认 #1' });
  const rejected = await confirmAutomationDraft({ automations: store }, first!);
  expect(rejected).toEqual({
    ok: false,
    status: SAME_NAME_TOAST,
    toast: SAME_NAME_TOAST,
  });
  expect(store.list()).toEqual([expect.objectContaining({ id: 1, name: 'Daily regression' })]);
  expect(store.getOperation(first!.operationId!)).toMatchObject({
    state: 'not-applied',
    code: 'same-name-confirmed',
    cardStatus: SAME_NAME_TOAST,
  });
});

it('rejects the later leftover twin after the earlier card was confirmed first', async () => {
  const store = await leftoverTwins();
  const [first, second] = store.listDrafts();
  expect(await confirmAutomationDraft({ automations: store }, first!)).toMatchObject({ ok: true, toast: '已确认 #1' });
  expect(await confirmAutomationDraft({ automations: store }, second!)).toEqual({
    ok: false,
    status: SAME_NAME_TOAST,
    toast: SAME_NAME_TOAST,
  });
  expect(store.list()).toEqual([expect.objectContaining({ id: 1, name: 'Daily regression' })]);
});

it('lets a later independent same-name draft coexist after the first task is already live', async () => {
  const { store, setNow } = await storeAt(NOW);
  const first = await saveReminder(store, { name: 'Daily regression', hour: 9, operationId: operationId(NOW) });
  expect(await confirmAutomationDraft({ automations: store }, first)).toMatchObject({ ok: true });
  setNow(NOW + 60_000);
  const later = await saveReminder(store, { name: 'Daily regression', hour: 8, minute: 45, operationId: operationId(NOW + 60_000) });
  expect(store.getOperation(later.operationId!)).toMatchObject({ state: 'received' });
  expect(await confirmAutomationDraft({ automations: store }, later)).toMatchObject({ ok: true, toast: '已确认 #2' });
  expect(store.list().map(item => item.id)).toEqual([1, 2]);
});

function createDraftName(draft: ReturnType<AutomationsStore['listDrafts']>[number] | undefined): string | undefined {
  return draft && draft.op !== 'delete' ? draft.name.trim() : undefined;
}

function operationId(issuedAt: number, chatId = CHAT): string {
  return newAutomationOperationId(automationOperationScope(PROFILE, chatId), issuedAt);
}

async function storeAt(initialNow: number): Promise<{ store: AutomationsStore; setNow: (next: number) => void }> {
  const dir = await mkdtemp(join(tmpdir(), 'same-name-revision-'));
  dirs.push(dir);
  let now = initialNow;
  const store = new AutomationsStore({
    path: join(dir, 'automations.json'),
    logPath: join(dir, 'automations.log'),
    statusPath: join(dir, 'status.json'),
    now: () => now,
  });
  await store.load();
  return { store, setNow: next => { now = next; } };
}

async function saveReminder(store: AutomationsStore, input: {
  name: string;
  hour: number;
  minute?: number;
  createdBy?: string;
  chatId?: string;
  profile?: string;
  operationId: string;
}) {
  const chatId = input.chatId ?? CHAT;
  const startAt = NOW;
  const fireAt = Date.UTC(2026, 9, 21, input.hour - 8, input.minute ?? 0);
  return store.saveDraft({
    taskType: 'reminder',
    schedule: { kind: 'daily', timezone: 'Asia/Shanghai', times: [{ hour: input.hour, minute: input.minute ?? 0 }], startAt, endAt: startAt + 7 * 86400000 },
    timezone: 'Asia/Shanghai',
    startAt,
    endAt: startAt + 7 * 86400000,
    nextFireAt: fireAt,
    chatId,
    createdBy: input.createdBy ?? ACTOR,
    name: input.name,
    taskText: 'Synthetic daily regression',
    operationId: input.operationId,
  }, {
    operationId: input.operationId,
    profile: input.profile ?? PROFILE,
    chatId,
    fingerprint: 'ab'.repeat(32),
  });
}

async function leftoverTwins(): Promise<AutomationsStore> {
  const dir = await mkdtemp(join(tmpdir(), 'same-name-leftover-'));
  dirs.push(dir);
  const firstId = operationId(NOW);
  const secondId = operationId(NOW + 1);
  const reminder = (draftId: string, operationId: string, createdAt: number, hour: number) => ({
    op: 'create',
    draftId,
    operationId,
    createdAt,
    chatId: CHAT,
    createdBy: ACTOR,
    taskType: 'reminder',
    name: 'Daily regression',
    taskText: 'Synthetic daily regression',
    timezone: 'Asia/Shanghai',
    schedule: { kind: 'daily', timezone: 'Asia/Shanghai', times: [{ hour, minute: 0 }], startAt: NOW, endAt: NOW + 7 * 86400000 },
    startAt: NOW,
    endAt: NOW + 7 * 86400000,
    nextFireAt: Date.UTC(2026, 9, 21, hour - 8, 0),
  });
  await writeFile(join(dir, 'automations.json'), JSON.stringify({
    schemaVersion: AUTOMATIONS_SCHEMA_VERSION,
    nextId: 1,
    items: [],
    started: [],
    boards: [],
    drafts: [
      reminder('draft-first', firstId, NOW, 9),
      reminder('draft-second', secondId, NOW + 1, 8),
    ],
    operations: [
      { operationId: firstId, profile: PROFILE, chatId: CHAT, fingerprint: 'ab'.repeat(32), draftId: 'draft-first', createdAt: NOW, state: 'received', dispatchedCount: 0 },
      { operationId: secondId, profile: PROFILE, chatId: CHAT, fingerprint: 'cd'.repeat(32), draftId: 'draft-second', createdAt: NOW + 1, state: 'received', dispatchedCount: 0 },
    ],
  }));
  const store = new AutomationsStore({
    path: join(dir, 'automations.json'),
    logPath: join(dir, 'automations.log'),
    statusPath: join(dir, 'status.json'),
    now: () => NOW + 2,
  });
  await store.load();
  return store;
}
