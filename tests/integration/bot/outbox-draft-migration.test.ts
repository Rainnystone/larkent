import { mkdtemp, readFile, writeFile, rm, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { AutomationsStore } from '../../../src/automations/store';
import { automationOperationScope, newAutomationOperationId } from '../../../src/automations/operation-id';
import { automationConfirmCard } from '../../../src/automations/confirm-card';
import { Outbox } from '../../../src/bot/outbox';
import { withDraftCardReadbackMarker } from '../../../src/bot/feishu-delivery';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(state: 'prepared' | 'sending') {
  const dir = await mkdtemp(join(tmpdir(), 'outbox-migrate-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const now = Date.now() - 1000;
  const options = { path: join(dir, 'automations.json'), logPath: join(dir, 'automations.log'), statusPath: join(dir, 'status.json'), now: () => now };
  const store = new AutomationsStore(options);
  await store.load();
  const operationId = newAutomationOperationId(automationOperationScope('profile', 'chat'), now);
  const draft = await store.saveDraft({ operationId, taskType: 'reminder', name: 'reminder', taskText: 'do it', chatId: 'chat', createdBy: 'user',
    schedule: { kind: 'one-shot', fireAt: now + 600_000 }, startAt: now, endAt: now + 600_000, nextFireAt: now + 600_000, timezone: 'UTC',
  }, { operationId, profile: 'profile', chatId: 'chat', fingerprint: 'ab'.repeat(32) });
  const deliveryId = 'ab'.repeat(16);
  const card = withDraftCardReadbackMarker(automationConfirmCard({ taskType: 'reminder', name: 'reminder', taskText: 'do it', timezone: 'UTC',
    schedule: { kind: 'one-shot', fireAt: now + 600_000 }, now, confirmToken: 'synthetic', rejectToken: 'synthetic-no' }), deliveryId);
  const channel = createRecordingLarkChannel();
  const cardId = state === 'sending' ? (await channel.createCard(card)).cardId : undefined;
  if (cardId) await channel.send('chat', { cardId }, { uuid: deliveryId });
  const legacy = JSON.parse(await readFile(options.path, 'utf8'));
  legacy.schemaVersion = 2;
  legacy.drafts[0].delivery = { state, deliveryId, card, ...(cardId ? { cardId } : {}) };
  const original = JSON.stringify(legacy);
  await writeFile(options.path, original);
  return { options, original, channel, draft, deliveryId, journalPath: join(dir, 'turn-journal.json') };
}

it.each(['prepared', 'sending'] as const)('upgrades a v2 %s draft and binds exactly one card across repeated restarts', async (state) => {
  const h = await fixture(state);
  // Simulate interruption after journal commit but before automations replacement.
  const transferred = new AutomationsStore(h.options);
  await transferred.load();
  await writeFile(h.options.path, h.original);
  const store = new AutomationsStore(h.options);
  await store.load();
  const persisted = JSON.parse(await readFile(h.options.path, 'utf8'));
  expect(persisted.schemaVersion).toBe(3);
  expect(persisted.drafts[0]).toMatchObject({ deliveryId: h.deliveryId });
  expect(persisted.drafts[0].delivery).toBeUndefined();
  const outbox = new Outbox({ channel: h.channel as unknown as LarkChannel, journal: store.outboxJournal, botAppId: 'cli_bot', draftCards: store });
  cleanups.push(async () => outbox.stop());
  await outbox.redeliver();
  const bound = store.getDraft(h.draft.draftId)!;
  expect(bound).toMatchObject({ cardMessageId: 'om_fake_1', cardId: expect.any(String), cardBody: expect.any(Object) });
  const restarted = new AutomationsStore(h.options);
  await restarted.load();
  const recovered = new Outbox({ channel: h.channel as unknown as LarkChannel, journal: restarted.outboxJournal, botAppId: 'cli_bot', draftCards: restarted });
  cleanups.push(async () => recovered.stop());
  await recovered.redeliver();
  expect(h.channel.sent).toHaveLength(1);
  expect(restarted.getDraft(h.draft.draftId)?.cardMessageId).toBe(bound.cardMessageId);
});

it('preserves the v2 source when the journal transfer cannot commit', async () => {
  const h = await fixture('sending');
  await mkdir(h.journalPath);
  const store = new AutomationsStore(h.options);
  await expect(store.load()).rejects.toThrow('Turn journal is not writable');
  expect(await readFile(h.options.path, 'utf8')).toBe(h.original);
  await expect(store.flush()).rejects.toThrow();
  await rm(h.journalPath, { recursive: true });
  const restarted = new AutomationsStore(h.options);
  await restarted.load();
  const outbox = new Outbox({ channel: h.channel as unknown as LarkChannel, journal: restarted.outboxJournal, botAppId: 'cli_bot', draftCards: restarted });
  cleanups.push(async () => outbox.stop());
  await outbox.redeliver();
  expect(h.channel.sent).toHaveLength(1);
  expect(restarted.getDraft(h.draft.draftId)?.cardMessageId).toBe('om_fake_1');
});

it('refuses a v3 draft whose durable delivery reference is missing, without replacing either file', async () => {
  const h = await fixture('sending');
  const upgraded = new AutomationsStore(h.options);
  await upgraded.load();
  const before = await readFile(h.options.path, 'utf8');
  const journal = JSON.parse(await readFile(h.journalPath, 'utf8'));
  delete journal.items[h.deliveryId];
  const corrupted = JSON.stringify(journal);
  await writeFile(h.journalPath, corrupted);
  const restarted = new AutomationsStore(h.options);
  await expect(restarted.load()).rejects.toThrow(/delivery reference/);
  expect(await readFile(h.options.path, 'utf8')).toBe(before);
  expect(await readFile(h.journalPath, 'utf8')).toBe(corrupted);
  expect(h.channel.sent).toHaveLength(1);
});

it('refuses explicit supersession of an unknown migrated card send', async () => {
  const h = await fixture('sending');
  const store = new AutomationsStore(h.options);
  await store.load();
  const operationId = newAutomationOperationId(automationOperationScope('profile', 'chat'), h.options.now() + 1);
  const { draftId: _id, createdAt: _created, ...input } = h.draft;
  await expect(store.saveDraft({ ...input, operationId }, {
    operationId, profile: 'profile', chatId: 'chat', fingerprint: 'cd'.repeat(32), supersedesOperationId: h.draft.operationId,
  })).rejects.toThrow();
  expect(store.getOperation(h.draft.operationId!)?.state).toBe('received');
  expect(store.getDraft(h.draft.draftId)?.delivery?.state).toBe('sending');
  expect(store.getOperation(operationId)).toBeUndefined();
});

it('commits the card entity before send and durably binds a lost receipt through unique readback', async () => {
  const h = await fixture('prepared');
  const store = new AutomationsStore(h.options);
  await store.load();
  const send = h.channel.send.bind(h.channel);
  let messageId = '';
  h.channel.send = async (...args) => {
    const disk = JSON.parse(await readFile(h.journalPath, 'utf8'));
    expect(disk.items[h.deliveryId]).toMatchObject({ kind: 'draft-card', cardId: expect.any(String), state: 'staged' });
    messageId = (await send(...args)).messageId;
    throw new Error('lost receipt');
  };
  const outbox = new Outbox({ channel: h.channel as unknown as LarkChannel, journal: store.outboxJournal, botAppId: 'cli_bot', draftCards: store });
  cleanups.push(async () => outbox.stop());
  await expect(outbox.reconcileDraftCard(h.deliveryId)).rejects.toThrow('lost receipt');
  expect(store.getDraft(h.draft.draftId)?.cardMessageId).toBeUndefined();
  const restarted = new AutomationsStore(h.options);
  await restarted.load();
  const recovered = new Outbox({ channel: h.channel as unknown as LarkChannel, journal: restarted.outboxJournal, botAppId: 'cli_bot', draftCards: restarted });
  cleanups.push(async () => recovered.stop());
  await recovered.redeliver();
  await recovered.redeliver();
  expect(h.channel.sent).toHaveLength(1);
  expect(restarted.getDraft(h.draft.draftId)).toMatchObject({ cardMessageId: messageId, cardId: expect.any(String), cardBody: expect.any(Object) });
  const reloaded = new AutomationsStore(h.options);
  await reloaded.load();
  expect(reloaded.findDraftByCardMessageId(messageId)?.draftId).toBe(h.draft.draftId);
});

it('retries a saved receipt hook after the automation write fails without sending or reading back again', async () => {
  const h = await fixture('prepared');
  const store = new AutomationsStore(h.options);
  await store.load();
  const backup = `${h.options.path}.backup`;
  const send = h.channel.send.bind(h.channel);
  let messageId = '';
  h.channel.send = async (...args) => {
    messageId = (await send(...args)).messageId;
    await rename(h.options.path, backup);
    await mkdir(h.options.path);
    return { messageId };
  };
  const outbox = new Outbox({ channel: h.channel as unknown as LarkChannel, journal: store.outboxJournal, botAppId: 'cli_bot', draftCards: store });
  cleanups.push(async () => outbox.stop());
  await expect(outbox.reconcileDraftCard(h.deliveryId)).rejects.toThrow();
  await rm(h.options.path, { recursive: true });
  await rename(backup, h.options.path);
  h.channel.send = async () => { throw new Error('must not resend a saved receipt'); };
  h.channel.rawClient.im.v1.message.list = async () => { throw new Error('must not read back a saved receipt'); };
  const restarted = new AutomationsStore(h.options);
  await restarted.load();
  const recovered = new Outbox({ channel: h.channel as unknown as LarkChannel, journal: restarted.outboxJournal, botAppId: 'cli_bot', draftCards: restarted });
  cleanups.push(async () => recovered.stop());
  await recovered.redeliver();
  const reloaded = new AutomationsStore(h.options);
  await reloaded.load();
  expect(reloaded.findDraftByCardMessageId(messageId)?.draftId).toBe(h.draft.draftId);
  expect(h.channel.sent).toHaveLength(1);
});
