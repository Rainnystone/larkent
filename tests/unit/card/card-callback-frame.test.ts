import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLarkChannel, type CardActionEvent } from '@larksuite/channel';
import { handleCardAction } from '../../../src/card/dispatcher';
import { log } from '../../../src/core/logger';
import { createUserActionHarness } from '../../helpers/user-action-context';

const require = createRequire(import.meta.url);
const sdkRequire = createRequire(createRequire(require.resolve('@larksuite/channel')).resolve('@larksuiteoapi/node-sdk'));
const { WSClient } = sdkRequire('@larksuiteoapi/node-sdk') as {
  WSClient: new (params: Record<string, unknown>) => SdkWsClient;
};
const { pbbp2 } = sdkRequire('protobufjs/minimal').roots.default as { pbbp2: FrameCodec };

interface FrameHeader { key: string; value: string }
interface Frame {
  SeqID: number; LogID: number; service: number; method: number;
  headers: FrameHeader[]; payload: Uint8Array;
}
interface FrameCodec {
  Frame: { encode(frame: Frame): { finish(): Uint8Array }; decode(buf: Uint8Array): Frame };
}
interface SdkWsClient {
  eventDispatcher: unknown;
  wsConfig: { setWSInstance(ws: unknown): void };
  dataCache: { timer?: ReturnType<typeof setInterval> };
  communicate(): void;
}
type InternalChannel = {
  registerDispatcherHandlers(): void;
  dispatcher: unknown;
  safety: { dispose(): Promise<void> };
};

/** Feishu: the callback must be answered within 3 s (card-callback-communication). */
const FEISHU_CALLBACK_BUDGET_MS = 3_000;
const silent = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * One click through the SDK's real long-connection path: a protobuf frame on
 * the socket, WSClient, EventDispatcher, LarkChannel's card.action.trigger
 * built-in and safety pipeline, the bridge handler, and the response frame
 * written back on the same socket. Returns how long the bridge held the
 * callback and what Feishu would read from the response frame.
 */
async function clickOverSocket(
  value: Record<string, unknown>,
  onCardAction: (evt: CardActionEvent) => Promise<unknown>,
  createTime: string = String(Date.now() * 1000),
  ids: { eventId?: string; openMessageId?: string; wsMessageId?: string } = {},
) {
  const { eventId = 'evt-1', openMessageId = 'om_card', wsMessageId = 'ws-msg-1' } = ids;
  const channel = createLarkChannel({
    appId: 'cli_test', appSecret: 'secret', logger: silent,
    safety: { chatQueue: { enabled: false } }, includeRawEvent: true,
  });
  channel.on({ cardAction: async (evt) => await onCardAction(evt) as Record<string, unknown> | void });
  const internals = channel as unknown as InternalChannel;
  internals.registerDispatcherHandlers();

  const sent: Array<{ at: number; frame: Frame }> = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    send(buf: Uint8Array, cb?: (err?: Error) => void) {
      sent.push({ at: performance.now(), frame: pbbp2.Frame.decode(buf) });
      cb?.();
    },
  });
  const ws = new WSClient({ appId: 'cli_test', appSecret: 'secret', logger: silent });
  ws.eventDispatcher = internals.dispatcher;
  ws.wsConfig.setWSInstance(socket);
  ws.communicate();
  cleanups.push(async () => {
    clearInterval(ws.dataCache.timer);
    await internals.safety.dispose();
  });

  const event = {
    schema: '2.0',
    header: {
      event_id: eventId, token: 'tok', create_time: createTime,
      event_type: 'card.action.trigger', tenant_key: 'tenant', app_id: 'cli_test',
    },
    event: {
      operator: { open_id: 'ou_user' },
      token: 'c-update-token',
      action: { tag: 'button', value },
      host: 'im_message',
      context: { open_message_id: openMessageId, open_chat_id: 'oc_group' },
    },
  };
  const inbound: Frame = {
    SeqID: 1, LogID: 2, service: 3, method: 1,
    headers: [
      { key: 'type', value: 'event' }, { key: 'message_id', value: wsMessageId },
      { key: 'sum', value: '1' }, { key: 'seq', value: '0' }, { key: 'trace_id', value: 'trace-1' },
    ],
    payload: new TextEncoder().encode(JSON.stringify(event)),
  };
  const receivedAt = performance.now();
  socket.emit('message', Buffer.from(pbbp2.Frame.encode(inbound).finish()));
  while (sent.length === 0 && performance.now() - receivedAt < FEISHU_CALLBACK_BUDGET_MS) {
    await new Promise((r) => setTimeout(r, 5));
  }

  expect(sent).toHaveLength(1);
  const out = sent[0]!;
  const headers = Object.fromEntries(out.frame.headers.map((h) => [h.key, h.value]));
  const body = JSON.parse(new TextDecoder().decode(out.frame.payload)) as { code: number; data?: string };
  return {
    heldMs: out.at - receivedAt,
    headers,
    code: body.code,
    response: body.data ? JSON.parse(Buffer.from(body.data, 'base64').toString('utf8')) as unknown : undefined,
  };
}

async function noticeHarness() {
  const h = await createUserActionHarness();
  cleanups.push(h.cleanup);
  h.controls.profileConfig.access.allowedUsers = ['ou_user'];
  h.journal.enqueue({
    turnId: 'turn-1', scope: 'oc_group', chatId: 'oc_group', messageIds: ['om_1'], senderId: 'ou_user',
    initiatorId: 'ou_user', status: 'notice-delivered', policyFingerprint: 'fp-1',
  });
  h.journal.recordNotice('turn-1', {
    kind: 'continue', recipientChatId: 'oc_group', markdown: '中断', includeButtons: true, messageId: 'om_card',
  });
  h.channel.updateCard = () => new Promise<void>(() => {});
  return h;
}

describe('card callback over the long connection', () => {
  it('answers 暂不 on the socket within Feishu\'s budget, while the card patch is still pending, with the resolved card as a raw JSON 1.0 object', async () => {
    const h = await noticeHarness();
    const token = h.runtime.noticeAuth!.sign({
      turnId: 'turn-1', scope: 'oc_group', chatId: 'oc_group',
      action: 'notice.dismiss', policyFingerprint: 'fp-1', ttlMs: 60_000,
    });

    const r = await clickOverSocket(
      { cmd: 'notice.dismiss', notice_token: token },
      (evt) => handleCardAction({ ...h.runtime, evt }),
    );

    expect(r.heldMs).toBeLessThan(FEISHU_CALLBACK_BUDGET_MS);
    expect(r.code).toBe(200);
    expect(r.headers).toMatchObject({ type: 'event', message_id: 'ws-msg-1', trace_id: 'trace-1' });
    expect(r.response).toEqual({
      card: {
        type: 'raw',
        data: {
          config: { wide_screen_mode: true, update_multi: true },
          header: { title: { tag: 'plain_text', content: '中断通知' } },
          elements: [{ tag: 'div', text: { tag: 'lark_md', content: '已忽略' } }],
        },
      },
    });
  });

  it('logs how long Feishu took to deliver the click from the header create_time, without ids', async () => {
    for (const [i, createTime] of [String((Date.now() - 1_500) * 1000), String(Date.now() - 1_500)].entries()) {
      const h = await noticeHarness();
      const token = h.runtime.noticeAuth!.sign({
        turnId: 'turn-1', scope: 'oc_group', chatId: 'oc_group',
        action: 'notice.dismiss', policyFingerprint: 'fp-1', ttlMs: 60_000,
      });
      const info = vi.spyOn(log, 'info').mockImplementation(() => {});
      await clickOverSocket(
        { cmd: 'notice.dismiss', notice_token: token },
        (evt) => handleCardAction({ ...h.runtime, evt }),
        createTime,
        { eventId: `evt-lag-${i}`, openMessageId: `om_card-lag-${i}`, wsMessageId: `ws-lag-${i}` },
      );
      const received = info.mock.calls.find((call) => call[0] === 'cardAction' && call[1] === 'received');
      expect(received).toBeTruthy();
      const fields = received?.[2] as Record<string, unknown>;
      expect(fields.feishuLagMs).toBeGreaterThanOrEqual(1_500);
      expect(fields.feishuLagMs).toBeLessThan(1_500 + FEISHU_CALLBACK_BUDGET_MS);
      expect(Object.keys(fields).sort()).toEqual(['cmd', 'feishuLagMs']);
      info.mockRestore();
    }
  });
});
