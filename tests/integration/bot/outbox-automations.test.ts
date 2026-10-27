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
