import { seedDraftDelivery } from '../../helpers/draft-delivery-fixture';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { confirmAutomationDraft } from '../../../src/automations/draft-confirmation';
import { automationConfirmCard } from '../../../src/automations/confirm-card';
import { reconcileDraftCard, sendAutomationDraftCard } from '../../../src/automations/draft-delivery';
import { automationEndCard } from '../../../src/automations/end-card';
import { automationOperationScope, newAutomationOperationId } from '../../../src/automations/operation-id';
import { AutomationsStore } from '../../../src/automations/store';
import { FEISHU_READBACK_PAGE_SIZE } from '../../../src/bot/feishu-delivery';
import { createFakeChannel } from '../../helpers/fake-channel';

const NOW = 1_760_000_000_000;
const APP = 'cli_bot';
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Outbox draft send evidence', () => {
  it('keeps sending when Feishu reports the card entity is already bound', async () => {
    const { store, draft, channel } = await liveDraft({});
    channel.send = async () => {
      throw Object.assign(new Error('card binding biz count over limit'), {
        response: {
          status: 400,
          data: { code: 230099, msg: 'ext=ErrCode: 200780; ErrMsg: card binding biz count over limit' },
        },
      });
    };
    await expect(sendAutomationDraftCard(
      channel as never,
      store,
      store.getDraft(draft.draftId)!,
      confirmCard(),
      {},
    )).rejects.toMatchObject({ response: { data: { code: 230099 } } });
    expect(store.getDraft(draft.draftId)?.delivery?.state).toBe('sending');
    expect(store.getDraft(draft.draftId)?.cardMessageId).toBeUndefined();
  });

  it('still marks a generic 4xx send as rejected', async () => {
    const { store, draft, channel } = await liveDraft({});
    channel.send = async () => {
      throw Object.assign(new Error('invalid content'), {
        response: { status: 400, data: { code: 200001, msg: 'synthetic rejection' } },
      });
    };
    await expect(sendAutomationDraftCard(
      channel as never,
      store,
      store.getDraft(draft.draftId)!,
      confirmCard(),
      {},
    )).rejects.toMatchObject({ response: { data: { code: 200001 } } });
    expect(store.getDraft(draft.draftId)?.delivery?.state).toBe('rejected');
  });
});

describe('reconcileDraftCard', () => {
  it('asks for user_card_content in both chat and thread containers', async () => {
    const listed: Record<string, unknown>[] = [];
    const chat = await sendingDraft({});
    const topic = await sendingDraft({ replyInThread: true, threadId: 'omt_topic' });
    const channel = createFakeChannel({ botAppId: APP, now: () => NOW });
    channel.rawClient.im.v1.message.list = async (params: unknown) => {
      listed.push(asListParams(params));
      return { data: { items: [], has_more: false } };
    };
    await reconcileDraftCard(channel as never, chat.store, chat.store.getDraft(chat.draft.draftId)!, APP);
    await reconcileDraftCard(channel as never, topic.store, topic.store.getDraft(topic.draft.draftId)!, APP);
    expect(listed).toEqual([
      {
        container_id_type: 'chat',
        container_id: 'oc_synthetic',
        start_time: String(Math.floor(NOW / 1000)),
        page_size: FEISHU_READBACK_PAGE_SIZE,
        sort_type: 'ByCreateTimeDesc',
        card_msg_content_type: 'user_card_content',
      },
      {
        container_id_type: 'thread',
        container_id: 'omt_topic',
        page_size: FEISHU_READBACK_PAGE_SIZE,
        sort_type: 'ByCreateTimeDesc',
        card_msg_content_type: 'user_card_content',
      },
    ]);
  });

  it('binds the unique matching card', async () => {
    const { store, draft, marker } = await sendingDraft({});
    const listed: Record<string, unknown>[] = [];
    await reconcileWith(store, draft.draftId, async (params) => {
      listed.push(asListParams(params));
      return page([matchItem('om_test_1', marker)]);
    });
    expect(listed[0]?.card_msg_content_type).toBe('user_card_content');
    expect(store.getDraft(draft.draftId)?.cardMessageId).toBe('om_test_1');
    expect(store.getDraft(draft.draftId)?.delivery?.state).toBe('sent');
    expect(store.findDraftByCardMessageId('om_test_1')?.draftId).toBe(draft.draftId);
  });

  it('does not bind when two messages carry the same marker', async () => {
    const { store, draft, marker } = await sendingDraft({});
    await reconcileWith(store, draft.draftId, async () => page([
      matchItem('om_test_1', marker),
      matchItem('om_test_2', marker),
    ]));
    expectUnbound(store, draft.draftId);
  });

  it('leaves sending when the list is empty, degraded, other-marked, from another sender, or too early', async () => {
    const cases = [
      async () => page([]),
      async () => page([{
        ...matchItem('om_degraded', 'unused'),
        body: { content: JSON.stringify({
          title: '确认自动化',
          elements: [[{ tag: 'img', image_key: 'img_test' }, { tag: 'text', text: '请升级至最新版本客户端，以查看内容' }]],
        }) },
      }]),
      async () => page([matchItem('om_other', `lbd${'c'.repeat(17)}`)]),
      async (marker: string) => page([matchItem('om_user', marker, { senderType: 'user' })]),
      async (marker: string) => page([matchItem('om_other_bot', marker, { senderId: 'cli_other' })]),
      async (marker: string) => page([matchItem('om_early', marker, { createTime: NOW - 1 })]),
    ];
    for (const respond of cases) {
      const { store, draft, marker } = await sendingDraft({});
      await reconcileWith(store, draft.draftId, async () => respond(marker));
      expectUnbound(store, draft.draftId);
    }
  });

  it('does not bind an old unmarked draft even when the list has auto_token evidence', async () => {
    const { store, draft } = await liveDraft({});
    await seedDraftDelivery(store, draft.draftId, {
      state: 'sending',
      deliveryId: 'cd'.repeat(16),
      card: { value: { auto_token: 'tok-confirm' } },
      cardId: 'card_1',
    });
    await reconcileWith(store, draft.draftId, async () => page([{
      message_id: 'om_legacy',
      msg_type: 'interactive',
      create_time: String(NOW + 500),
      sender: { id: APP, id_type: 'app_id', sender_type: 'app' },
      body: { content: JSON.stringify({ value: { auto_token: 'tok-confirm' } }) },
    }]));
    expectUnbound(store, draft.draftId);
  });

  it('binds a match on the second page', async () => {
    const { store, draft, marker } = await sendingDraft({});
    const listed: Record<string, unknown>[] = [];
    await reconcileWith(store, draft.draftId, async (params) => {
      const nested = asListParams(params);
      listed.push(nested);
      if (nested.page_token === 'p2') return page([matchItem('om_test_1', marker)]);
      return { data: { items: [], has_more: true, page_token: 'p2' } };
    });
    expect(listed).toHaveLength(2);
    expect(listed[0]?.card_msg_content_type).toBe('user_card_content');
    expect(store.getDraft(draft.draftId)?.cardMessageId).toBe('om_test_1');
  });
});

it.each(['confirm', 'end'] as const)('binds a landed %s card after a lost receipt so the same card remains usable', async phase => {
  const { store, draft, channel } = await liveDraft(phase === 'end' ? { pendingRecurring: { kind: 'daily', timezone: 'Asia/Shanghai', times: [{ hour: 9, minute: 0 }] } } : {});
  const send = channel.send.bind(channel);
  let messageId = '';
  channel.send = async (...args) => { const sent = await send(...args); messageId = sent.messageId; throw new Error('lost receipt'); };
  await expect(sendAutomationDraftCard(
    channel as never,
    store,
    store.getDraft(draft.draftId)!,
    phase === 'end' ? endCard() : confirmCard(),
    {},
  )).rejects.toThrow('lost receipt');
  const live = store.getDraft(draft.draftId)!;
  expect(live.delivery?.state).toBe('sending');
  expect(live.cardMessageId).toBeUndefined();
  const marker = `lbd${deliveryIdFor(draft.operationId!, phase).slice(0, 17)}`;
  const listedCard = asUserCardContent(live.delivery!.card);
  expect(JSON.stringify(listedCard)).not.toContain('auto_token');
  expect(JSON.stringify(listedCard)).toContain(marker);
  channel.rawClient.im.v1.message.list = async (params: unknown) => {
    expect(asListParams(params).card_msg_content_type).toBe('user_card_content');
    return page([matchItem(messageId, marker, { body: listedCard })]);
  };
  await reconcileDraftCard(channel as never, store, store.getDraft(draft.draftId)!, APP);
  expect(store.findDraftByCardMessageId(messageId)?.draftId).toBe(draft.draftId);
  if (phase === 'end') {
    expect(channel.sent.filter(item => JSON.stringify(item.content).includes('auto.end.'))).toHaveLength(1);
    return;
  }
  const confirmed = await confirmAutomationDraft({ automations: store, now: () => NOW }, store.getDraft(draft.draftId)!);
  expect(confirmed).toEqual({ ok: true, status: '已确认 #1', toast: '已确认 #1' });
  expect(store.getOperation(draft.operationId!)?.state).toBe('applied');
  expect(channel.sent.filter((item) => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
});

async function liveDraft(input: {
  replyInThread?: boolean;
  threadId?: string;
  pendingRecurring?: { kind: 'daily'; timezone: string; times: Array<{ hour: number; minute: number }> };
}) {
  const dir = await mkdtemp(join(tmpdir(), 'draft-delivery-'));
  dirs.push(dir);
  const store = new AutomationsStore({
    path: join(dir, 'automations.json'),
    logPath: join(dir, 'automations.log'),
    statusPath: join(dir, 'status.json'),
    now: () => NOW,
  });
  await store.load();
  const profile = 'synthetic';
  const chatId = 'oc_synthetic';
  const operationId = newAutomationOperationId(automationOperationScope(profile, chatId), NOW);
  const draft = await store.saveDraft({
    taskType: 'reminder',
    schedule: input.pendingRecurring ?? { kind: 'one-shot', fireAt: NOW + 600_000 },
    timezone: 'Asia/Shanghai',
    startAt: NOW + 600_000,
    ...(input.pendingRecurring ? {} : { endAt: NOW + 600_000 }),
    nextFireAt: input.pendingRecurring ? 0 : NOW + 600_000,
    chatId,
    createdBy: 'ou_synthetic',
    name: 'Synthetic reminder',
    taskText: 'Synthetic reminder body',
    operationId,
    ...(input.pendingRecurring ? { pendingRecurring: input.pendingRecurring } : {}),
    cardReply: { replyTo: 'om_src', ...(input.replyInThread ? { replyInThread: true } : {}), ...(input.threadId ? { threadId: input.threadId } : {}) },
  }, { operationId, profile, chatId, fingerprint: 'ab'.repeat(32) });
  return { store, draft, channel: createFakeChannel({ botAppId: APP, now: () => NOW + 500 }) };
}

async function sendingDraft(input: Parameters<typeof liveDraft>[0]) {
  const ctx = await liveDraft(input);
  const deliveryId = 'ab'.repeat(16);
  const marker = `lbd${deliveryId.slice(0, 17)}`;
  await seedDraftDelivery(ctx.store, ctx.draft.draftId, {
    state: 'sending',
    deliveryId,
    card: markedUserCard(marker),
    cardId: 'card_1',
  });
  return { ...ctx, marker };
}

async function reconcileWith(
  store: AutomationsStore,
  draftId: string,
  list: (params: unknown) => Promise<unknown>,
): Promise<void> {
  const channel = createFakeChannel({ botAppId: APP, now: () => NOW });
  channel.rawClient.im.v1.message.list = list;
  await reconcileDraftCard(channel as never, store, store.getDraft(draftId)!, APP);
}

function expectUnbound(store: AutomationsStore, draftId: string): void {
  expect(store.getDraft(draftId)?.cardMessageId).toBeUndefined();
  expect(store.getDraft(draftId)?.delivery?.state).toBe('sending');
}

function confirmCard(): object {
  return automationConfirmCard({
    taskType: 'reminder',
    name: 'Synthetic reminder',
    taskText: 'Synthetic reminder body',
    timezone: 'Asia/Shanghai',
    schedule: { kind: 'one-shot', fireAt: NOW + 600_000 },
    now: NOW,
    confirmToken: 'auto_cb.v1.confirm',
    rejectToken: 'auto_cb.v1.reject',
  });
}

function endCard(): object {
  return automationEndCard({
    'auto.end.1w': 'auto_cb.v1.1w',
    'auto.end.2w': 'auto_cb.v1.2w',
    'auto.end.1m': 'auto_cb.v1.1m',
    'auto.end.3m': 'auto_cb.v1.3m',
    'auto.end.eoy': 'auto_cb.v1.eoy',
    'auto.end.1y': 'auto_cb.v1.1y',
    'auto.end.custom': 'auto_cb.v1.custom',
    'auto.reject': 'auto_cb.v1.reject',
  });
}

function deliveryIdFor(operationId: string, kind: 'confirm' | 'end'): string {
  return createHash('sha256').update(`${operationId}:${kind}`).digest('hex').slice(0, 32);
}

function markedUserCard(marker: string): object {
  return {
    schema: '2.0',
    config: { enable_forward_interaction: false, streaming_mode: false, summary: { content: '确认自动化' } },
    header: { title: { tag: 'plain_text', content: '确认自动化' } },
    body: { elements: [
      { tag: 'markdown', element_id: '_10', content: '**任务类型：** 提醒 …' },
      { tag: 'hr', element_id: '_9' },
      { tag: 'column_set', element_id: '_2', columns: [{ tag: 'column', element_id: '_6', elements: [{
        tag: 'button',
        element_id: marker,
        text: { tag: 'plain_text', content: '是' },
        type: 'primary',
      }] }] },
    ] },
  };
}

function matchItem(messageId: string, marker: string, extra: {
  senderId?: string;
  senderType?: string;
  createTime?: number;
  body?: object;
} = {}): Record<string, unknown> {
  return {
    message_id: messageId,
    msg_type: 'interactive',
    create_time: String(extra.createTime ?? NOW + 500),
    sender: { id: extra.senderId ?? APP, id_type: 'app_id', sender_type: extra.senderType ?? 'app' },
    body: { content: JSON.stringify(extra.body ?? markedUserCard(marker)) },
  };
}

function page(items: Record<string, unknown>[]): { data: { items: Record<string, unknown>[]; has_more: boolean } } {
  return { data: { items, has_more: false } };
}

function asUserCardContent(card: object): object {
  return stripCallbacks(structuredClone(card)) as object;
}

function stripCallbacks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCallbacks);
  if (!value || typeof value !== 'object') return value;
  const rec = value as Record<string, unknown>;
  if (rec.tag === 'button') {
    return {
      tag: 'button',
      ...(typeof rec.element_id === 'string' ? { element_id: rec.element_id } : {}),
      ...(rec.text !== undefined ? { text: rec.text } : {}),
      ...(rec.type !== undefined ? { type: rec.type } : {}),
    };
  }
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(rec)) {
    if (key === 'behaviors' || key === 'value') continue;
    next[key] = stripCallbacks(child);
  }
  return next;
}

function asListParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object') return {};
  const rec = params as Record<string, unknown>;
  const nested = rec.params;
  if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
  return rec;
}
