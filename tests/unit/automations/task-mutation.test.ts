import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AutoActionAuth } from '../../../src/automations/action-auth';
import { mutateAutomationTask } from '../../../src/automations/task-mutation';
import { createAutomationScheduler } from '../../../src/automations/scheduler';
import { AutomationsStore, automationTargetRevision, type CreateAutomationInput } from '../../../src/automations/store';
import { Outbox } from '../../../src/bot/outbox';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';

const NOW = Date.UTC(2026, 9, 19);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

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
