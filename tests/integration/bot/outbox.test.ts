import {
  mkdtemp,
  readFile,
  writeFile,
  rename,
  mkdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { FEISHU_UUID_WINDOW_MS } from '../../../src/bot/feishu-delivery';
import { Outbox } from '../../../src/bot/outbox';
import { TurnJournal } from '../../../src/bot/turn-journal';
import {
  axiosHttpError,
  sdkShapedSendError,
  axiosErrno,
} from '../../helpers/sdk-feishu-errors';
import { initialState } from '../../../src/card/run-state';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  options: {
    now?: () => number;
    isActive?: (scope: string) => boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'outbox-'));
  const journal = new TurnJournal(join(dir, 'turn-journal.json'), {
    now: options.now,
  });
  await journal.load();
  journal.enqueue({
    turnId: 'turn-1',
    scope: 'chat',
    chatId: 'chat',
    messageIds: ['parent'],
    senderId: 'user',
    initiatorId: 'user',
    status: 'queued',
  });
  const channel = createRecordingLarkChannel();
  let down = false;
  const outbox = new Outbox({
    channel: channel as unknown as LarkChannel,
    journal,
    botAppId: 'cli_bot',
    isDown: () => down,
    ...options,
  });
  cleanups.push(async () => {
    outbox.stop();
    await journal.flush();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    journal,
    channel,
    outbox,
    setDown: (value: boolean) => {
      down = value;
    },
  };
}

function finalReply() {
  return {
    chatId: 'chat',
    scope: 'chat',
    turnId: 'turn-1',
    replyMode: 'text' as const,
    state: {
      ...initialState,
      terminal: 'done' as const,
      blocks: [{ kind: 'text' as const, content: 'answer', streaming: false }],
    },
    sendOpts: { replyTo: 'parent' },
    cardRenderOptions: {},
    onWait: () => {},
    outcome: {
      kind: 'completed' as const,
      retriable: false,
      needsHuman: false,
    },
  };
}

describe('Outbox', () => {
  it('stages while the link is down and delivers once after recovery', async () => {
    const h = await fixture();
    h.setDown(true);
    await h.outbox.deliverFinalReply(finalReply());
    expect(h.channel.sent).toHaveLength(0);
    expect(h.journal.get('turn-1')?.reply?.state).toBe('staged');
    h.setDown(false);
    await h.outbox.redeliver();
    await h.outbox.redeliver();
    expect(h.channel.sent).toHaveLength(1);
    expect(h.journal.get('turn-1')?.reply).toMatchObject({
      state: 'sent',
      messageId: 'om_fake_1',
    });
  });
  it('surfaces not-in-chat and rejects the item without retrying it', async () => {
    const h = await fixture();
    h.channel.sendErrors.send = Object.assign(new Error('not in chat'), {
      response: { status: 400, data: { code: 230002 } },
    });
    await expect(
      h.outbox.deliverFinalReply(finalReply()),
    ).rejects.toBeDefined();
    expect(h.journal.get('turn-1')?.reply?.state).toBe('rejected');
    await h.outbox.redeliver();
    expect(h.channel.sent).toHaveLength(0);
  });

  it('atomically upgrades v1 staged reply and notice items, then redelivers once', async () => {
    const h = await fixture();
    await h.journal.flush();
    const file = h.journal.getFilePath();
    const entry = h.journal.get('turn-1')!;
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            ...entry,
            status: 'notice-pending',
            reply: { markdown: 'answer', replyTo: 'parent', replyMode: 'text' },
            notice: {
              kind: 'plain',
              recipientChatId: 'chat',
              markdown: 'notice',
              replyTo: 'parent',
            },
          },
        ],
      }),
    );
    const restarted = new TurnJournal(file);
    await restarted.load();
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    expect(persisted.schemaVersion).toBe(2);
    expect(persisted.entries[0].reply).toBeUndefined();
    expect(Object.keys(persisted.items)).toHaveLength(2);
    const outbox = new Outbox({
      channel: h.channel as unknown as LarkChannel,
      journal: restarted,
      botAppId: 'cli_bot',
    });
    await outbox.redeliver();
    await outbox.redeliver();
    expect(h.channel.sent.map((row) => row.content)).toEqual([
      { markdown: 'answer' },
      { markdown: 'notice' },
    ]);
    expect(restarted.get('turn-1')?.reply?.state).toBe('sent');
    expect(restarted.get('turn-1')?.notice?.state).toBe('sent');
    outbox.stop();
  });

  it.each(['card', 'markdown', 'text'] as const)(
    'delivers one final %s reply with a stable uuid and actual receipt',
    async (replyMode) => {
      const h = await fixture();
      await h.outbox.deliverFinalReply({ ...finalReply(), replyMode });
      await h.outbox.redeliver();
      expect(h.channel.sent).toHaveLength(1);
      expect(h.channel.sent[0]?.options).toMatchObject({
        replyTo: 'parent',
        uuid: h.journal.get('turn-1')?.reply?.deliveryId,
      });
      expect(h.journal.get('turn-1')?.reply).toMatchObject({
        state: 'sent',
        messageId: 'om_fake_1',
      });
    },
  );

  it('falls back once to plain text after rejection and retries local failures once before waiting', async () => {
    const rejected = await fixture();
    rejected.channel.sendErrors.send = axiosHttpError(400);
    await rejected.outbox.deliverFinalReply(finalReply());
    expect(rejected.channel.sent.map((row) => row.content)).toEqual([
      { text: 'answer' },
    ]);
    const local = await fixture();
    let attempts = 0;
    const send = local.channel.send.bind(local.channel);
    local.channel.send = async (...args) => {
      attempts += 1;
      if (attempts <= 2) throw new Error('closed');
      return send(...args);
    };
    await local.outbox.deliverFinalReply(finalReply());
    expect(attempts).toBe(2);
    expect(local.journal.get('turn-1')?.reply?.state).toBe('staged');
    await local.outbox.redeliver();
    expect(local.channel.sent).toHaveLength(1);
  });

  it.each(['card', 'markdown'] as const)(
    'marks a confirmed %s stream delivered before awaiting its journal flush',
    async (replyMode) => {
      const h = await fixture();
      const pending = h.outbox.deliverFinalReply({
        ...finalReply(),
        replyMode,
        stream: { kind: 'confirmed', messageId: 'stream-receipt' },
      });
      await Promise.resolve();
      expect(h.journal.get('turn-1')?.reply).toMatchObject({
        state: 'sent',
        messageId: 'stream-receipt',
        interactive: true,
      });
      await pending;
      expect(h.channel.sent).toHaveLength(0);
    },
  );

  it.each(['card', 'markdown'] as const)(
    'patches a failed %s stream receipt in place and uuid-sends once if it is gone',
    async (replyMode) => {
      const h = await fixture();
      await h.outbox.deliverFinalReply({
        ...finalReply(),
        replyMode,
        stream: {
          kind: 'failed',
          messageId: 'stream-receipt',
          err: new Error('closed'),
        },
      });
      expect(h.journal.get('turn-1')?.reply?.state).toBe('staged');
      await h.outbox.redeliver();
      expect(h.channel.updatedCards.map((row) => row.messageId)).toEqual([
        'stream-receipt',
      ]);
      expect(h.channel.sent).toHaveLength(0);
      h.journal.stageReply('turn-1', {
        markdown: 'answer',
        replyTo: 'parent',
        replyMode,
        messageId: 'gone',
        interactive: true,
      });
      h.channel.cardErrors.update = axiosHttpError(404);
      await h.outbox.redeliver();
      await h.outbox.redeliver();
      expect(h.channel.sent).toHaveLength(1);
    },
  );

  it('retains independent reply and notice receipts when a notice fails, then retries only the notice', async () => {
    const h = await fixture();
    h.journal.stageReply('turn-1', {
      markdown: 'answer',
      replyTo: 'parent',
      replyMode: 'text',
    });
    h.journal.stageNotice('turn-1', {
      kind: 'plain',
      recipientChatId: 'chat',
      markdown: 'notice',
    });
    const send = h.channel.send.bind(h.channel);
    h.channel.send = async (...args) => {
      if (JSON.stringify(args[1]).includes('notice'))
        throw sdkShapedSendError('send_timeout', new Error('timeout'));
      return send(...args);
    };
    await expect(h.outbox.redeliver()).rejects.toBeDefined();
    await expect(h.outbox.redeliver()).rejects.toBeDefined();
    expect(h.channel.sent).toHaveLength(1);
    expect(h.journal.get('turn-1')?.reply?.state).toBe('sent');
    h.channel.send = send;
    await h.outbox.redeliver();
    expect(h.channel.sent).toHaveLength(2);
  });

  it('voids only the notice on abandonment and voids all remaining items on session switch', async () => {
    const h = await fixture();
    h.journal.stageReply('turn-1', {
      markdown: 'answer',
      replyTo: 'parent',
      replyMode: 'text',
    });
    h.journal.stageNotice('turn-1', {
      kind: 'plain',
      recipientChatId: 'chat',
      markdown: 'notice',
    });
    h.journal.setContinuation('turn-1', 'abandoned', {
      noticeInvalidated: true,
    });
    await h.outbox.redeliver();
    expect(h.channel.sent.map((row) => row.content)).toEqual([
      { markdown: 'answer' },
    ]);
    h.journal.stageReply('turn-1', {
      markdown: 'late',
      replyTo: 'parent',
      replyMode: 'text',
    });
    h.journal.voidScope('chat');
    await h.outbox.redeliver();
    expect(h.channel.sent).toHaveLength(1);
  });

  it('stops at the first link error, then delivers the remaining staged items on recovery', async () => {
    const h = await fixture();
    h.journal.stageReply('turn-1', {
      markdown: 'first',
      replyTo: 'parent',
      replyMode: 'text',
    });
    h.journal.enqueue({
      ...h.journal.get('turn-1')!,
      turnId: 'turn-2',
      reply: undefined,
    });
    h.journal.stageReply('turn-2', {
      markdown: 'second',
      replyTo: 'parent',
      replyMode: 'text',
    });
    h.channel.sendErrors.send = sdkShapedSendError(
      'send_timeout',
      new Error('timeout'),
    );
    await expect(h.outbox.redeliver()).rejects.toBeDefined();
    expect(h.channel.sent).toHaveLength(0);
    await h.outbox.redeliver();
    expect(h.channel.sent.map((row) => row.content)).toEqual([
      { markdown: 'first' },
      { markdown: 'second' },
    ]);
  });

  it('keeps pending notices out of live scopes and rate-limits recovery notices', async () => {
    let active = true;
    const delays: number[] = [];
    const h = await fixture({
      isActive: () => active,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    h.journal.stageNotice('turn-1', {
      kind: 'plain',
      recipientChatId: 'chat',
      markdown: 'one',
    });
    h.journal.enqueue({
      ...h.journal.get('turn-1')!,
      turnId: 'turn-2',
      notice: undefined,
    });
    h.journal.stageNotice('turn-2', {
      kind: 'plain',
      recipientChatId: 'chat',
      markdown: 'two',
    });
    await h.outbox.redeliver();
    expect(h.channel.sent).toHaveLength(0);
    active = false;
    await h.outbox.redeliver();
    expect(h.channel.sent.map((row) => row.content)).toEqual([
      { markdown: 'one' },
      { markdown: 'two' },
    ]);
    expect(delays).toEqual([500]);
  });

  it('skips a CLI-delivered turn without suppressing an older staged turn in the same scope', async () => {
    const h = await fixture();
    h.journal.stageReply('turn-1', {
      markdown: 'older',
      replyTo: 'parent',
      replyMode: 'text',
    });
    h.journal.enqueue({
      ...h.journal.get('turn-1')!,
      turnId: 'turn-2',
      reply: undefined,
    });
    h.journal.stageReply('turn-2', {
      markdown: 'already sent',
      replyTo: 'parent',
      replyMode: 'text',
    });
    h.journal.noteCliAlreadySentForScope('chat', 'turn-2');
    await h.outbox.redeliver();
    expect(h.channel.sent.map((row) => row.content)).toEqual([
      { markdown: 'older' },
    ]);
    expect(h.journal.get('turn-2')?.reply?.state).toBe('sent');
  });

  it('reads back an old uuid send by parent, bot and creation time without sending again', async () => {
    let now = Date.now();
    const h = await fixture({ now: () => now, sleep: async () => {} });
    await h.channel.send('chat', { markdown: 'answer' }, { replyTo: 'parent' });
    h.journal.stageReply('turn-1', {
      markdown: 'answer',
      replyTo: 'parent',
      replyMode: 'text',
    });
    now += FEISHU_UUID_WINDOW_MS + 1;
    await h.outbox.redeliver();
    expect(
      h.channel.rawClient.requests.some(
        (row) => row.method === 'im.v1.message.list',
      ),
    ).toBe(true);
    expect(h.channel.sent).toHaveLength(1);
  });

  it('does not send staged recovery items when their durable write fails', async () => {
    const h = await fixture();
    await h.journal.flush();
    const file = h.journal.getFilePath();
    await rename(file, `${file}.backup`);
    await mkdir(file);
    try {
      h.journal.stageReply('turn-1', {
        markdown: 'answer',
        replyTo: 'parent',
        replyMode: 'text',
      });
      await expect(h.outbox.redeliver()).rejects.toBeDefined();
      expect(h.channel.sent).toHaveLength(0);
    } finally {
      await h.journal.flush().catch(() => {});
      await rm(file, { recursive: true });
      await rename(`${file}.backup`, file);
      await h.journal.load();
    }
  });

  it.each([
    ['link', sdkShapedSendError('send_timeout', new Error('timeout')), true],
    ['local', new Error('closed'), true],
    ['gone', axiosHttpError(404), false],
    ['permanent', axiosHttpError(403), false],
  ] as const)(
    'recalls a superseded message with %s handling without resending the replacement',
    async (_kind, error, retry) => {
      const h = await fixture();
      const recall = h.channel.recallMessage.bind(h.channel);
      let attempts = 0;
      h.channel.recallMessage = async (id) => {
        attempts += 1;
        if (attempts === 1) throw error;
        return recall(id);
      };
      await h.outbox.stage({
        kind: 'reply',
        turnId: 'turn-1',
        payload: {
          markdown: 'replacement',
          replyTo: 'parent',
          replyMode: 'text',
          supersedes: 'old-promise',
        },
      });
      await h.outbox.redeliver();
      expect(h.journal.get('turn-1')?.reply?.state).toBe(
        retry ? 'staged' : 'sent',
      );
      await h.outbox.redeliver();
      expect(attempts).toBe(retry ? 2 : 1);
      expect(h.channel.sent).toHaveLength(1);
      expect(h.journal.get('turn-1')?.reply?.state).toBe('sent');
    },
  );

  it('refuses a future journal without replacing its bytes', async () => {
    const h = await fixture();
    await h.journal.flush();
    const file = h.journal.getFilePath();
    const original =
      '{"schemaVersion":99,"entries":[],"items":{"future":"data"}}';
    await writeFile(file, original);
    const future = new TurnJournal(file);
    await future.load();
    future.enqueue({ ...h.journal.get('turn-1')!, turnId: 'new' });
    await future.flush();
    expect(await readFile(file, 'utf8')).toBe(original);
  });
  it('does not deliver a stale staged entry after the scope is voided', async () => {
    const h = await fixture();
    await h.outbox.stage({
      kind: 'reply',
      turnId: 'turn-1',
      payload: { markdown: 'answer', replyTo: 'parent', replyMode: 'text' },
    });
    const staged = h.journal.get('turn-1')!;
    h.outbox.voidScope('chat');
    expect(await h.outbox.deliver(staged)).toBe(false);
    expect(h.channel.sent).toHaveLength(0);
  });
  it('does not send a notice voided during the staging flush', async () => {
    const h = await fixture();
    const pending = h.outbox.deliverNotice({
      turnId: 'turn-1',
      outcome: {
        kind: 'interrupted',
        reason: { type: 'external-signal' },
        retriable: true,
        needsHuman: false,
      },
      consecutive: 4,
      requireBotMention: false,
    });
    h.outbox.voidScope('chat');
    expect(await pending).toBe(false);
    expect(h.channel.sent).toHaveLength(0);
  });

  it('does not send a final reply voided during the staging flush', async () => {
    const h = await fixture();
    const pending = h.outbox.deliverFinalReply(finalReply());
    h.outbox.voidScope('chat');
    await pending;
    expect(h.channel.sent).toHaveLength(0);
  });
});
