import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { draftConfirmationDelivery } from '../../../src/automations/draft-confirmation';
import { automationConfirmCard } from '../../../src/automations/confirm-card';
import { sendAutomationDraftCard } from '../../../src/automations/draft-confirmation/delivery';
import { automationOperationScope, newAutomationOperationId } from '../../../src/automations/operation-id';
import { AutomationsStore } from '../../../src/automations/store';
import { createFakeChannel } from '../../helpers/fake-channel';

const fsGate = vi.hoisted(() => ({ beforeRename: undefined as undefined | ((destination: string) => Promise<void>) }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (from: string, to: string) => { await fsGate.beforeRename?.(String(to)); return actual.rename(from, to); } };
});

const NOW = 1_760_000_000_000;
const dirs: string[] = [];
afterEach(async () => { fsGate.beforeRename = undefined; await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it('commits a draft write without waiting for the shared journal, then drops the closed card on flush', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draft-retention-'));
  dirs.push(dir);
  const journalPath = join(dir, 'journal.json');
  const journal = new TurnJournal(journalPath, { now: () => NOW });
  await journal.load();
  const store = new AutomationsStore({ journal, path: join(dir, 'automations.json'), logPath: join(dir, 'automations.log'), statusPath: join(dir, 'status.json'), now: () => NOW });
  await store.load();
  const operationId = newAutomationOperationId(automationOperationScope('profile', 'oc_chat'), NOW + 1);
  const draft = await store.saveDraft({ taskType: 'reminder', schedule: { kind: 'one-shot', fireAt: NOW + 600_000 }, timezone: 'UTC',
    startAt: NOW + 600_000, endAt: NOW + 600_000, nextFireAt: NOW + 600_000, chatId: 'oc_chat', createdBy: 'ou_user',
    name: 'closed sent', taskText: 'body', operationId }, { operationId, profile: 'profile', chatId: 'oc_chat', fingerprint: '1'.padStart(64, '0') });
  await sendAutomationDraftCard(createFakeChannel({ botAppId: 'cli_bot', now: () => NOW + 500 }) as never, store, store.getDraft(draft.draftId)!, automationConfirmCard({
    taskType: 'reminder', name: 'n', taskText: 'body', timezone: 'UTC', schedule: { kind: 'one-shot', fireAt: NOW + 600_000 },
    now: NOW, confirmToken: 'auto_cb.v1.confirm', rejectToken: 'auto_cb.v1.reject' }), {});
  const deliveryId = store.getDraftCardReceipt(draft.draftId)!.deliveryId!;
  await store.flush();
  expect(journal.getDraftCard(deliveryId)?.state).toBe('sent');

  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let reached!: (draftsOnDisk: unknown[]) => void;
  const journalWriteStarted = new Promise<unknown[]>(resolve => { reached = resolve; });
  fsGate.beforeRename = async destination => {
    if (destination !== journalPath) return;
    fsGate.beforeRename = undefined;
    reached(JSON.parse(await readFile(join(dir, 'automations.json'), 'utf8')).drafts);
    await held;
  };
  try {
    const taking = store.takeDraft(draft.draftId);
    expect(await journalWriteStarted).toEqual([]);
    expect(await Promise.race([taking.then(() => 'committed'), sleep(1000).then(() => 'waiting on journal')])).toBe('committed');
  } finally { release(); }
  await store.flush();
  expect(journal.listDraftCards()).toEqual([]);
  expect(JSON.parse(await readFile(journalPath, 'utf8')).items ?? {}).toEqual({});
});

it('drops terminal draft cards once no draft references them, keeping unresolved sends and live references across reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draft-retention-'));
  dirs.push(dir);
  const options = { path: join(dir, 'automations.json'), logPath: join(dir, 'automations.log'), statusPath: join(dir, 'status.json'), now: () => NOW };
  const store = new AutomationsStore(options);
  await store.load();
  const channel = createFakeChannel({ botAppId: 'cli_bot', now: () => NOW + 500 });
  const send = channel.send.bind(channel);
  let seq = 0;
  const draft = async (name: string) => {
    const operationId = newAutomationOperationId(automationOperationScope('profile', 'oc_chat'), NOW + ++seq);
    return store.saveDraft({ taskType: 'reminder', schedule: { kind: 'one-shot', fireAt: NOW + 600_000 }, timezone: 'UTC',
      startAt: NOW + 600_000, endAt: NOW + 600_000, nextFireAt: NOW + 600_000, chatId: 'oc_chat', createdBy: 'ou_user',
      name, taskText: 'body', operationId }, { operationId, profile: 'profile', chatId: 'oc_chat', fingerprint: `${seq}`.padStart(64, '0') });
  };
  const deliver = (draftId: string) => sendAutomationDraftCard(channel as never, store, store.getDraft(draftId)!, automationConfirmCard({
    taskType: 'reminder', name: 'n', taskText: 'body', timezone: 'UTC', schedule: { kind: 'one-shot', fireAt: NOW + 600_000 },
    now: NOW, confirmToken: 'auto_cb.v1.confirm', rejectToken: 'auto_cb.v1.reject' }), {});
  const deliveryOf = (draftId: string) => store.getDraftCardReceipt(draftId)!.deliveryId!;

  const closedSent = await draft('closed sent');
  await deliver(closedSent.draftId);
  const closedSentId = deliveryOf(closedSent.draftId);

  const closedRejected = await draft('closed rejected');
  channel.send = async () => { throw Object.assign(new Error('invalid content'), { response: { status: 400, data: { code: 200001, msg: 'synthetic' } } }); };
  await expect(deliver(closedRejected.draftId)).rejects.toThrow('invalid content');
  const closedRejectedId = deliveryOf(closedRejected.draftId);

  const closedUnknown = await draft('closed unknown');
  channel.send = async (...args) => { await send(...args); throw new Error('lost receipt'); };
  await expect(deliver(closedUnknown.draftId)).rejects.toThrow('lost receipt');
  const closedUnknownId = deliveryOf(closedUnknown.draftId);
  channel.send = send;

  const live = await draft('live sent');
  await deliver(live.draftId);
  const liveId = deliveryOf(live.draftId);

  expect(store.outboxJournal.getDraftCard(closedSentId)?.state).toBe('sent');
  expect(store.outboxJournal.getDraftCard(closedRejectedId)?.state).toBe('rejected');
  expect(store.outboxJournal.getDraftCard(closedUnknownId)).toMatchObject({ state: 'staged', cardId: expect.any(String) });

  await store.takeDraft(closedSent.draftId);
  await store.rejectOperation(closedRejected.operationId!, 'draft-rejected');
  await store.takeDraft(closedUnknown.draftId);
  await store.flush();

  const retained = [closedUnknownId, liveId].sort();
  expect(store.outboxJournal.listDraftCards().map(item => item.deliveryId).sort()).toEqual(retained);
  const disk = JSON.parse(await readFile(join(dir, 'turn-journal.json'), 'utf8'));
  expect(Object.keys(disk.items).sort()).toEqual(retained);

  const reloaded = new AutomationsStore(options);
  await reloaded.load();
  expect(reloaded.outboxJournal.listDraftCards().map(item => item.deliveryId).sort()).toEqual(retained);
  expect(reloaded.outboxJournal.getDraftCard(closedUnknownId)).toMatchObject({ state: 'staged', cardId: expect.any(String) });
  expect(draftConfirmationDelivery(reloaded.getDraft(live.draftId))).toMatchObject({ state: 'sent', messageId: expect.any(String) });
});
