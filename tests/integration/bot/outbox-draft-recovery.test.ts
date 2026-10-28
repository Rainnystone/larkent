import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { draftConfirmationDelivery } from '../../../src/automations/draft-confirmation';
import { automationConfirmCard } from '../../../src/automations/confirm-card';
import { automationOperationScope, newAutomationOperationId } from '../../../src/automations/operation-id';
import { AutomationsStore } from '../../../src/automations/store';
import { Outbox } from '../../../src/bot/outbox';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel';

const NOW = 1_760_000_000_000;
const APP = 'app-bot';
const DELIVERY_ID = 'cd'.repeat(16);
const dirs: string[] = [];
const outboxes: Outbox[] = [];
afterEach(async () => {
  for (const outbox of outboxes.splice(0)) outbox.stop();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it('sends the card exactly once on recovery when the link dropped after the card entity committed but before send', async () => {
  const h = await fixture();
  let down = false;
  let created = 0;
  const create = h.channel.createCard.bind(h.channel);
  h.channel.createCard = async card => { created += 1; const out = await create(card); down = true; return out; };
  const outbox = outboxFor(h.channel, h.store, () => down);
  await expect(outbox.deliverDraftCard(h.input)).rejects.toThrow('unknown or pending');
  expect(h.channel.sent).toHaveLength(0);

  const restarted = new AutomationsStore(h.options);
  await restarted.load();
  const recovered = outboxFor(h.channel, restarted);
  await recovered.redeliver();
  await recovered.redeliver();

  expect(created).toBe(1);
  expect(h.channel.sent).toHaveLength(1);
  expect(restarted.outboxJournal.getDraftCard(DELIVERY_ID)?.state).toBe('sent');
  expect(draftConfirmationDelivery(restarted.getDraft(h.draftId))).toMatchObject({ state: 'sent', messageId: expect.any(String) });
});

it('only reads back on recovery once a send was attempted, never sending the card twice', async () => {
  const h = await fixture();
  let sends = 0;
  let listed = 0;
  h.channel.send = async () => { sends += 1; throw new Error('lost receipt'); };
  const outbox = outboxFor(h.channel, h.store);
  await expect(outbox.deliverDraftCard(h.input)).rejects.toThrow('lost receipt');
  expect(sends).toBe(1);

  h.channel.rawClient.im.v1.message.list = async () => { listed += 1; return { data: { items: [], has_more: false } }; };
  const restarted = new AutomationsStore(h.options);
  await restarted.load();
  const recovered = outboxFor(h.channel, restarted);
  await recovered.redeliver();
  await recovered.redeliver();

  expect(sends).toBe(1);
  expect(listed).toBeGreaterThan(0);
  expect(restarted.outboxJournal.getDraftCard(DELIVERY_ID)).toMatchObject({ state: 'staged', cardId: expect.any(String) });
  expect(draftConfirmationDelivery(restarted.getDraft(h.draftId)).messageId).toBeUndefined();
});

function outboxFor(channel: FakeChannel, store: AutomationsStore, isDown?: () => boolean): Outbox {
  const outbox = new Outbox({ channel: channel as unknown as LarkChannel, journal: store.outboxJournal, botAppId: APP, draftCards: store, isDown, liveSweep: false });
  outboxes.push(outbox);
  return outbox;
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'outbox-draft-recovery-'));
  dirs.push(dir);
  const options = { path: join(dir, 'automations.json'), logPath: join(dir, 'automations.log'), statusPath: join(dir, 'status.json'), now: () => NOW };
  const store = new AutomationsStore(options);
  await store.load();
  const chatId = 'chat-synthetic';
  const operationId = newAutomationOperationId(automationOperationScope('profile', chatId), NOW);
  const draft = await store.saveDraft({ taskType: 'reminder', schedule: { kind: 'one-shot', fireAt: NOW + 600_000 }, timezone: 'UTC',
    startAt: NOW + 600_000, endAt: NOW + 600_000, nextFireAt: NOW + 600_000, chatId, createdBy: 'user-synthetic',
    name: 'Synthetic reminder', taskText: 'body', operationId }, { operationId, profile: 'profile', chatId, fingerprint: 'ab'.repeat(32) });
  const card = automationConfirmCard({ taskType: 'reminder', name: 'Synthetic reminder', taskText: 'body', timezone: 'UTC',
    schedule: { kind: 'one-shot', fireAt: NOW + 600_000 }, now: NOW, confirmToken: 'auto_cb.v1.confirm', rejectToken: 'auto_cb.v1.reject' });
  const input = { draftId: draft.draftId, chatId, deliveryId: DELIVERY_ID, createdAt: draft.createdAt, card, options: {} };
  return { options, store, draftId: draft.draftId, input, channel: createFakeChannel({ botAppId: APP, now: () => NOW + 500 }) };
}
