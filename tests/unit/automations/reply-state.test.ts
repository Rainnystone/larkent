import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { toolResult } from '../../../src/bridge-tools/protocol';
import { DRAFT_SETTLED_SUPERSEDED } from '../../../src/automations/draft-card';
import { automationOperationScope, newAutomationOperationId } from '../../../src/automations/operation-id';
import { trackAutomationReply } from '../../../src/automations/reply-state';
import { AutomationsStore } from '../../../src/automations/store';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const PROFILE = 'synthetic';
const CHAT = 'oc_synthetic';
const ACTOR = 'ou_synthetic';
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it('omits the invalidated notice when this turn created the superseding draft', async () => {
  const { store, context } = await fixture();
  const tracker = trackAutomationReply(context);
  const first = await saveReminder(store, 'Morning reminder', NOW);
  tracker.noteResult(waiting(first.operationId!));
  const second = await saveReminder(store, 'Morning reminder', NOW + 1);
  tracker.noteResult(waiting(second.operationId!));
  expect(store.getOperation(first.operationId!)).toMatchObject({ code: 'draft-superseded' });
  expect(tracker.notice()).toBeUndefined();
});

it('does not throw when noting a result after a persist write fails', async () => {
  const { store, context } = await fixture();
  const first = await saveReminder(store, 'Morning reminder', NOW);
  const path = store.getFilePath();
  await rename(path, `${path}.saved`);
  await mkdir(path);
  await expect(saveReminder(store, 'Morning reminder', NOW + 1)).rejects.toThrow();
  expect(() => store.getOperation(first.operationId!)).toThrow();
  const tracker = trackAutomationReply(context);
  expect(() => tracker.noteResult(toolResult('unknown', 'persistence-or-delivery-unknown', {
    operationId: first.operationId,
    state: 'unknown',
    applied: null,
  }))).not.toThrow();
});

it('keeps the invalidated notice when another turn superseded the waiting draft', async () => {
  const { store, context } = await fixture();
  const tracker = trackAutomationReply(context);
  const first = await saveReminder(store, 'Morning reminder', NOW);
  tracker.noteResult(waiting(first.operationId!));
  await saveReminder(store, 'Morning reminder', NOW + 1);
  expect(store.getOperation(first.operationId!)).toMatchObject({ code: 'draft-superseded' });
  expect(tracker.notice()).toBe(`（回复生成期间已失效：${DRAFT_SETTLED_SUPERSEDED}）`);
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'reply-state-'));
  dirs.push(dir);
  const store = new AutomationsStore({
    path: join(dir, 'automations.json'),
    logPath: join(dir, 'automations.log'),
    statusPath: join(dir, 'status.json'),
    now: () => NOW,
  });
  await store.load();
  return {
    store,
    context: { store, profile: PROFILE, chatId: CHAT, now: () => NOW },
  };
}

async function saveReminder(store: AutomationsStore, name: string, issuedAt: number) {
  const operationId = newAutomationOperationId(automationOperationScope(PROFILE, CHAT), issuedAt);
  return store.saveDraft({
    taskType: 'reminder',
    schedule: { kind: 'one-shot', fireAt: NOW + 3600000 },
    timezone: 'Asia/Shanghai',
    startAt: NOW + 3600000,
    endAt: NOW + 3600000,
    nextFireAt: NOW + 3600000,
    chatId: CHAT,
    createdBy: ACTOR,
    name,
    taskText: 'Synthetic body',
    operationId,
  }, { operationId, profile: PROFILE, chatId: CHAT, fingerprint: issuedAt.toString(16).padStart(64, '0') });
}

function waiting(operationId: string) {
  return toolResult('waiting-confirmation', 'waiting-confirmation', { operationId, state: 'waiting-confirmation', applied: false });
}
