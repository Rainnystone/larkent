import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { Outbox } from '../../../src/bot/outbox';
import { TurnJournal } from '../../../src/bot/turn-journal';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.each(['reminder', 'result'] as const)('stages a %s under its fire and delivers it once after restart', async (kind) => {
  const dir = await mkdtemp(join(tmpdir(), 'outbox-auto-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal.json');
  const journal = new TurnJournal(path);
  await journal.load();
  const channel = createRecordingLarkChannel();
  const offline = new Outbox({ channel: channel as unknown as LarkChannel, journal, botAppId: 'cli_bot', isDown: () => true });
  await offline.deliverAutomation({ kind, turnId: 'af:1@100', chatId: 'chat', markdown: 'scheduled answer', actor: 'bot' });
  expect(channel.sent).toHaveLength(0);
  const document = JSON.parse(await readFile(path, 'utf8'));
  expect(document.items['reply:af:1@100']).toMatchObject({ kind, turnId: 'af:1@100', state: 'staged' });
  const restarted = new TurnJournal(path);
  await restarted.load();
  const online = new Outbox({ channel: channel as unknown as LarkChannel, journal: restarted, botAppId: 'cli_bot' });
  cleanups.push(async () => { offline.stop(); online.stop(); });
  await online.redeliver();
  await online.deliverAutomation({ kind, turnId: 'af:1@100', chatId: 'chat', markdown: 'scheduled answer', actor: 'bot' });
  expect(channel.sent.map(row => row.content)).toEqual([{ markdown: 'scheduled answer' }]);
  expect(restarted.get('af:1@100')?.reply).toMatchObject({ state: 'sent', messageId: expect.any(String) });
});

it('commits the card entity before send and binds a unique readback after a lost receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outbox-draft-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal.json');
  const journal = new TurnJournal(path);
  await journal.load();
  const channel = createRecordingLarkChannel();
  const send = channel.send.bind(channel);
  let messageId = '';
  channel.send = async (...args) => {
    const disk = JSON.parse(await readFile(path, 'utf8'));
    expect(disk.items['ab'.repeat(16)]).toMatchObject({ kind: 'draft-card', cardId: expect.any(String), state: 'staged' });
    messageId = (await send(...args)).messageId;
    throw new Error('lost receipt');
  };
  const receipts: unknown[] = [];
  const bindDraftCard = async (...receipt: unknown[]) => { receipts.push(receipt); return true; };
  const draftCards = { getDraft: () => ({ draftId: 'draft' }), bindDraftCard };
  const first = new Outbox({ channel: channel as unknown as LarkChannel, journal, botAppId: 'cli_bot', draftCards });
  await expect(first.deliverDraftCard({ draftId: 'draft', chatId: 'chat', deliveryId: 'ab'.repeat(16), createdAt: Date.now() - 1000,
    card: { schema: '2.0', header: { title: { content: 'Confirm' } }, config: { summary: { content: 'Confirm' } }, body: { elements: [{ tag: 'markdown', content: 'confirm me' }, { tag: 'button', type: 'primary', text: { content: '是' }, behaviors: [{type: 'callback', value: { cmd: 'auto.confirm' }}] }] } }, options: {},
  })).rejects.toThrow('lost receipt');
  expect(receipts).toEqual([]);
  const restarted = new TurnJournal(path);
  await restarted.load();
  const recovered = new Outbox({ channel: channel as unknown as LarkChannel, journal: restarted, botAppId: 'cli_bot', draftCards });
  cleanups.push(async () => { first.stop(); recovered.stop(); });
  await recovered.redeliver();
  await recovered.redeliver();
  expect(channel.sent).toHaveLength(1);
  expect(receipts).toEqual([[ 'draft', messageId, expect.any(String), expect.objectContaining({ elements: expect.any(Array) }) ]]);
});
