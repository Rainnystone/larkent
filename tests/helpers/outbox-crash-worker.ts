import { join } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import { Outbox } from '../../src/bot/outbox';
import { TurnJournal } from '../../src/bot/turn-journal';
import { crashRecordingChannel } from './outbox-crash-channel';

const [dir, phase] = process.argv.slice(2);
if (!dir || !phase) throw new Error('missing crash fixture arguments');
const channel = crashRecordingChannel(join(dir, 'remote.json'));
const journal = new TurnJournal(join(dir, 'turn-journal.json'));
await journal.load();
journal.enqueue({
  turnId: 'crash-turn',
  scope: 'chat',
  chatId: 'chat',
  messageIds: ['parent'],
  senderId: 'user',
  initiatorId: 'user',
  status: 'settled',
});
const pause = async (): Promise<never> => {
  process.send?.('paused');
  setInterval(() => {}, 1000);
  return new Promise(() => {});
};
let supersedes: string | undefined;
if (phase === 'recall') {
  supersedes = (await channel.send('chat', { markdown: 'old promise' }))
    .messageId;
  channel.recallMessage = pause;
} else {
  const send = channel.send.bind(channel);
  channel.send = async (...args) => {
    if (phase === 'stage') await pause();
    const receipt = await send(...args);
    await pause();
    return receipt;
  };
}
const outbox = new Outbox({
  channel: channel as unknown as LarkChannel,
  journal,
  botAppId: 'cli_bot',
});
await outbox.stage({
  kind: 'reply',
  turnId: 'crash-turn',
  payload: {
    markdown: 'answer',
    replyTo: 'parent',
    replyMode: 'text',
    ...(supersedes ? { supersedes } : {}),
  },
});
await outbox.deliver(journal.get('crash-turn')!);
throw new Error('crash checkpoint was not reached');
