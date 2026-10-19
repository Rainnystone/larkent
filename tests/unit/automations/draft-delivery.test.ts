import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { reconcileDraftCard } from '../../../src/automations/draft-delivery';
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

it('omits time-range parameters when reconciling a topic confirmation card', async () => {
  const { store, draft } = await fixture({ replyInThread: true, threadId: 'omt_topic' });
  const listed: Record<string, unknown>[] = [];
  const channel = createFakeChannel({ botAppId: APP, now: () => NOW });
  channel.rawClient.im.v1.message.list = async (params: unknown) => {
    listed.push(asListParams(params));
    return {
      data: {
        items: [{
          message_id: 'om_topic_card',
          sender: { id: APP, sender_type: 'app' },
          create_time: String(NOW + 1_000),
          body: { content: JSON.stringify({ value: { auto_token: 'tok-confirm' } }) },
        }],
        has_more: false,
      },
    };
  };
  await reconcileDraftCard(channel as never, store, store.getDraft(draft.draftId)!, APP);
  expect(listed).toEqual([{
    container_id_type: 'thread',
    container_id: 'omt_topic',
    page_size: FEISHU_READBACK_PAGE_SIZE,
    sort_type: 'ByCreateTimeDesc',
  }]);
  expect(store.getDraft(draft.draftId)?.cardMessageId).toBe('om_topic_card');
});

it('keeps start_time when reconciling a chat confirmation card', async () => {
  const { store, draft } = await fixture({});
  const listed: Record<string, unknown>[] = [];
  const channel = createFakeChannel({ botAppId: APP, now: () => NOW });
  channel.rawClient.im.v1.message.list = async (params: unknown) => {
    listed.push(asListParams(params));
    return { data: { items: [], has_more: false } };
  };
  await reconcileDraftCard(channel as never, store, store.getDraft(draft.draftId)!, APP);
  expect(listed).toEqual([{
    container_id_type: 'chat',
    container_id: 'oc_synthetic',
    start_time: String(Math.floor(NOW / 1000)),
    page_size: FEISHU_READBACK_PAGE_SIZE,
    sort_type: 'ByCreateTimeDesc',
  }]);
});

async function fixture(cardReply: { replyInThread?: boolean; threadId?: string }) {
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
    schedule: { kind: 'one-shot', fireAt: NOW + 600_000 },
    timezone: 'Asia/Shanghai',
    startAt: NOW + 600_000,
    endAt: NOW + 600_000,
    nextFireAt: NOW + 600_000,
    chatId,
    createdBy: 'ou_synthetic',
    name: 'Synthetic reminder',
    taskText: 'Synthetic reminder body',
    operationId,
    cardReply: { replyTo: 'om_src', ...cardReply },
  }, { operationId, profile, chatId, fingerprint: 'ab'.repeat(32) });
  await store.setDraftDelivery(draft.draftId, {
    state: 'sending',
    deliveryId: 'ab'.repeat(16),
    card: { value: { auto_token: 'tok-confirm' } },
    cardId: 'card_1',
  });
  return { store, draft };
}

function asListParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object') return {};
  const rec = params as Record<string, unknown>;
  const nested = rec.params;
  if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
  return rec;
}
