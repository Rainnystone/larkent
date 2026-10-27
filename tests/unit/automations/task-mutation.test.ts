import { automationOperationScope, newAutomationOperationId } from '../../../src/automations/operation-id';
import { callAutomationTool } from '../../../src/automations/tools';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AutoActionAuth } from '../../../src/automations/action-auth';
import { mutateAutomationTask, readAutomationTasks, readAutomationReceipt } from '../../../src/automations/task-mutation';
import { createAutomationScheduler } from '../../../src/automations/scheduler';
import { AutomationsStore, automationTargetRevision, type CreateAutomationInput } from '../../../src/automations/store';
import { Outbox } from '../../../src/bot/outbox';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';

const fsFault = vi.hoisted(() => ({ beforeRename: undefined as undefined | ((destination: string) => Promise<void>) }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (from: string, to: string) => { await fsFault.beforeRename?.(String(to)); return actual.rename(from, to); } };
});

const NOW = Date.UTC(2026, 9, 19);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { fsFault.beforeRename = undefined; for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('applies a human delete immediately and asks for confirmation for a model delete', async () => {
  const h = await harness();
  const humanTarget = await h.store.create(reminder());
  const modelTarget = await h.store.create(reminder());
  const human = await mutateAutomationTask(h.context, { actor: 'human', operation: 'delete', id: humanTarget.id });
  const model = await mutateAutomationTask(h.context, { actor: 'model', operation: 'delete', id: modelTarget.id,
    createdBy: 'ou_synthetic', registration: { operationId: 'synthetic-operation', fingerprint: 'delete', profile: 'synthetic', chatId: 'oc_synthetic' }, drafts: h.drafts });
  expect([human.ok, model.ok, h.store.list().map(item => item.id), h.channel.sent.length]).toEqual([true, true, [modelTarget.id], 1]);
  expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('auto.confirm');
});

it('applies a confirmed human replacement atomically and refuses its stale revision', async () => {
  const h = await harness();
  const original = await h.store.create(reminder());
  const revision = automationTargetRevision(original);
  await h.store.pause(original.id);
  expect(await mutateAutomationTask(h.context, { actor: 'human', operation: 'replace', id: original.id, revision,
    replacement: { ...reminder(), name: 'Replacement' } })).toMatchObject({ ok: false, code: 'target-state-conflict' });
  expect(await mutateAutomationTask(h.context, { actor: 'human', operation: 'replace', id: original.id,
    replacement: { ...reminder(), name: 'Replacement' } })).toMatchObject({ ok: true, item: { id: 2, name: 'Replacement' } });
  expect(h.store.list().map(item => item.name)).toEqual(['Replacement']);
});

it('rejects a model action when the target changes while it waits behind scheduler work', async () => {
  const h = await harness();
  const item = await h.store.create(reminder());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = h.context.scheduler.updateTasks(async () => { await gate; return { ok: await h.store.pause(item.id) }; });
  const mutation = mutateAutomationTask(h.context, { actor: 'model', operation: 'resume', id: item.id,
    createdBy: 'ou_synthetic', registration: { operationId: 'synthetic-race', fingerprint: 'resume', profile: 'synthetic', chatId: 'oc_synthetic' }, drafts: h.drafts });
  release();
  await queued;
  expect(await mutation).toMatchObject({ ok: false, code: 'target-state-conflict' });
  expect(h.store.get(item.id)?.paused).toBe(true);
});

it('keeps task queries and receipts committed while an atomic mutation write is pending', async () => {
  const h = await harness();
  const item = await h.store.create(reminder());
  let entered!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fsFault.beforeRename = async destination => { if (destination === h.store.getFilePath()) { entered(); await gate; } };
  const mutation = mutateAutomationTask(h.context, { actor: 'model', operation: 'pause', id: item.id,
    createdBy: 'ou_synthetic', registration: { operationId: 'synthetic-pending', fingerprint: 'pause', profile: 'synthetic', chatId: 'oc_synthetic' }, drafts: h.drafts });
  await writing;
  try {
    expect(readAutomationTasks(h.store, { chatId: 'oc_synthetic', consistency: 'live' })[0]?.paused).toBe(true);
    expect(readAutomationTasks(h.store, { chatId: 'oc_synthetic', consistency: 'committed' })[0]?.paused).toBe(false);
    expect(readAutomationReceipt(h.store, 'synthetic-pending')).toBeUndefined();
  } finally { release(); }
  expect(await mutation).toMatchObject({ ok: true });
  expect(readAutomationReceipt(h.store, 'synthetic-pending')?.operation).toMatchObject({ state: 'applied', taskId: item.id });
  expect(readAutomationTasks(h.store, { chatId: 'oc_synthetic', consistency: 'committed' })[0]?.paused).toBe(true);
});

it.each(['human', 'model'] as const)('keeps %s pause and resume immediate', async actor => {
  const h = await harness();
  const item = await h.store.create(reminder());
  for (const operation of ['pause', 'resume'] as const) {
    const identity = actor === 'human' ? { actor } : { actor, createdBy: 'ou_synthetic', drafts: h.drafts,
      registration: { operationId: `synthetic-${operation}`, fingerprint: operation, profile: 'synthetic', chatId: 'oc_synthetic' } };
    expect(await mutateAutomationTask(h.context, { ...identity, operation, id: item.id })).toMatchObject({ ok: true });
    expect(h.store.get(item.id)?.paused).toBe(operation === 'pause');
  }
  expect(h.channel.sent).toEqual([]);
});

it.each([999, 1])('conceals missing or other-chat targets behind the same error for target %s', async id => {
  const h = await harness();
  await h.store.create({ ...reminder(), chatId: 'oc_other' });
  expect(await mutateAutomationTask(h.context, { actor: 'human', operation: 'delete', id })).toEqual({ ok: false, code: 'target-not-found' });
  expect(h.store.list()).toHaveLength(1);
});

it('retains a task and its failed tool resume receipt when no fires remain, while a human resume removes it', async () => {
  const h = await harness();
  const item = await h.store.create({ ...reminder(), paused: true });
  h.setNow(NOW + 900_000);
  const context = { profile: 'synthetic', chatId: 'oc_synthetic', actorId: 'ou_synthetic', runType: 'im' as const,
    availability: () => undefined, store: h.store, drafts: h.drafts, timezone: 'UTC', agentTasks: false, now: h.context.now };
  const operationId = newAutomationOperationId(automationOperationScope(context.profile, context.chatId), context.now());
  const params = { id: item.id, operationId };
  const result = await callAutomationTool('automation.resume', params, context);
  expect(result).toMatchObject({ category: 'execution-failed', code: 'no-remaining-fires', data: { applied: false } });
  await h.store.load();
  expect(await callAutomationTool('automation.resume', params, context)).toEqual(result);
  expect(h.store.get(item.id)?.paused).toBe(true);
  expect(await mutateAutomationTask(h.context, { actor: 'human', operation: 'resume', id: item.id })).toMatchObject({ ok: true });
  expect(h.store.list()).toEqual([]);
});

it('does not resume a model task whose last fire passes while queued', async () => {
  const h = await harness();
  const item = await h.store.create({ ...reminder(), paused: true });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = h.context.scheduler.updateTasks(async () => { await gate; return { ok: false }; });
  const mutation = mutateAutomationTask(h.context, { actor: 'model', operation: 'resume', id: item.id,
    createdBy: 'ou_synthetic', registration: { operationId: 'synthetic-expired', fingerprint: 'resume', profile: 'synthetic', chatId: 'oc_synthetic' }, drafts: h.drafts });
  h.setNow(NOW + 900_000);
  release(); await queued;
  expect(await mutation).toEqual({ ok: false, code: 'no-remaining-fires' });
  expect(h.store.get(item.id)?.paused).toBe(true);
});

function reminder(): CreateAutomationInput {
  return { taskType: 'reminder', schedule: { kind: 'one-shot', fireAt: NOW + 900_000 }, timezone: 'UTC',
    startAt: NOW, endAt: NOW + 900_000, nextFireAt: NOW + 900_000, chatId: 'oc_synthetic', createdBy: 'ou_synthetic', name: 'Review', taskText: 'Review the plan' };
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'task-mutation-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let now = NOW;
  const store = new AutomationsStore({ path: join(dir, 'automations.json'), logPath: join(dir, 'automations.log'), statusPath: join(dir, 'status.json'), now: () => now });
  const channel = createRecordingLarkChannel();
  const nonces = new CallbackNonceStore(join(dir, 'nonces.json'));
  cleanups.push(() => nonces.flush());
  const autoAuth = new AutoActionAuth({ secret: 'synthetic-secret', nonceStore: nonces, now: () => now });
  store.draftOutbox = new Outbox({ channel: channel as never, journal: store.outboxJournal, draftCards: store, botAppId: 'cli_synthetic', liveSweep: false });
  const scheduler = createAutomationScheduler({ store, sender: { send() {} }, notifier: { notify() {} }, botDisplayName: () => 'Synthetic', now: () => now });
  cleanups.push(async () => { scheduler.stop(); await scheduler.idle(); await store.flush(); });
  const context = { store, scheduler, chatId: 'oc_synthetic', now: () => now };
  const drafts = { automations: store, automationsScheduler: scheduler, channel: channel as never, autoAuth, now: () => now };
  return { store, channel, context, drafts, setNow(value: number) { now = value; } };
}
