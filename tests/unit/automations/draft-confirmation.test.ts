import { automationTargetSnapshot } from '../../../src/automations/confirm-card';
import { automationOperationScope, newAutomationOperationId } from '../../../src/automations/operation-id';
import { createAutomationScheduler } from '../../../src/automations/scheduler';
import { axiosErrno } from '../../helpers/sdk-feishu-errors';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AutoActionAuth } from '../../../src/automations/action-auth';
import { submitDraft, flushDraftConfirmations, handleDraftAction, expireDraftConfirmations, draftConfirmationDelivery } from '../../../src/automations/draft-confirmation';
import { AutomationsStore, AUTOMATIONS_DRAFT_TTL_MS, automationTargetRevision, type CreateAutomationInput } from '../../../src/automations/store';
import { Outbox } from '../../../src/bot/outbox';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';

const NOW = Date.UTC(2026, 9, 18, 3);
const dirs: string[] = [];
const nonces: CallbackNonceStore[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(nonces.splice(0).map(store => store.flush())); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it('submits one confirmation through the real Outbox and concurrent flushes leave one visible card', async () => {
  const h = await harness();
  const draft = await submitDraft(h.ctx, reminder());
  await Promise.all([flushDraftConfirmations(h.ctx), flushDraftConfirmations(h.ctx, draft.draftId)]);
  expect(h.channel.sent).toHaveLength(1);
  expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('auto.confirm');
  expect(h.channel.sent[0]?.options).toMatchObject({ uuid: expect.any(String) });
});

it('accepts a signed confirmation once and settles the same visible card', async () => {
  const h = await harness();
  await submitDraft(h.ctx, reminder());
  const token = buttonToken(h.channel.sent[0]?.content, 'auto.confirm');
  const action = { action: 'auto.confirm' as const, token, chatId: 'oc_group', messageId: 'om_fake_1' };
  expect(await handleDraftAction(h.ctx, action)).toEqual({ ok: true, message: '已确认 #1' });
  expect(await handleDraftAction(h.ctx, action)).toEqual({ ok: false, message: '此确认已失效。' });
  await new Promise(resolve => setImmediate(resolve));
  expect(h.store.list()).toHaveLength(1);
  expect(h.channel.sent).toHaveLength(1);
  await expect.poll(() => JSON.stringify(h.channel.updatedCards)).toContain('已确认 #1');
});

it.each(['replace', 'delete'] as const)('submits and applies a %s once through the same confirmation interface', async op => {
  const h = await harness();
  const original = await h.store.create(reminder());
  const draft = await submitDraft(h.ctx, { ...reminder(), op, targetId: original.id, target: automationTargetSnapshot(original), name: 'Replacement' });
  expect(h.channel.sent).toHaveLength(1);
  expect(await tap(h, 'auto.confirm')).toEqual({ ok: true, message: op === 'replace' ? '已替换 #1 → #2' : '已删除 #1' });
  expect(await tap(h, 'auto.confirm')).toEqual({ ok: false, message: '此确认已失效。' });
  expect(h.store.get(original.id)).toBeUndefined();
  expect(h.store.list().map(item => item.name)).toEqual(op === 'replace' ? ['Replacement'] : []);
  expect(h.store.getDraft(draft.draftId)).toBeUndefined();
});

it('rejects once without creating a task', async () => {
  const h = await harness();
  await submitDraft(h.ctx, reminder());
  expect(await tap(h, 'auto.reject')).toEqual({ ok: true, message: '已取消' });
  expect(await tap(h, 'auto.confirm')).toEqual({ ok: false, message: '此确认已失效。' });
  expect(h.store.list()).toEqual([]);
});

it('validates end input without consuming it, then advances once to a separate confirmation', async () => {
  const h = await harness();
  const pending = { kind: 'daily' as const, timezone: 'UTC', times: [{ hour: 12, minute: 0 }] };
  await submitDraft(h.ctx, { ...reminder(), schedule: pending, pendingRecurring: pending, nextFireAt: 0, endAt: undefined });
  expect(h.channel.sent).toHaveLength(1);
  expect(await tap(h, 'auto.end.custom', { customText: 'not a date' })).toEqual({ ok: false, message: '无法解析结束时间。' });
  expect(await tap(h, 'auto.end.custom', { customText: '2026-10-25 12:00' })).toEqual({ ok: true, message: '已指定结束时间' });
  expect(await tap(h, 'auto.end.custom', { customText: '2026-10-25 12:00' }, 0)).toEqual({ ok: false, message: '此确认已失效。' });
  expect(h.channel.sent).toHaveLength(2);
  expect(await tap(h, 'auto.confirm', {}, 1)).toEqual({ ok: true, message: '已确认 #1' });
  expect(h.store.list()[0]?.endAt).toBe(Date.UTC(2026, 9, 25, 12));
});

it.each(['chat', 'message', 'token', 'expiry'] as const)('rejects a %s mismatch without mutating the task', async reason => {
  const h = await harness();
  await submitDraft(h.ctx, reminder());
  if (reason === 'expiry') h.setNow(NOW + AUTOMATIONS_DRAFT_TTL_MS);
  const overrides = reason === 'chat' ? { chatId: 'oc_other' } : reason === 'message' ? { messageId: 'om_other' } : reason === 'token' ? { token: 'forged' } : {};
  expect(await tap(h, 'auto.confirm', overrides)).toEqual({ ok: false, message: '此确认已失效。' });
  expect(h.store.list()).toEqual([]);
});

it('refuses a stale revision while retaining the changed target', async () => {
  const h = await harness();
  const item = await h.store.create(reminder());
  await submitDraft(h.ctx, { op: 'delete', chatId: item.chatId, createdBy: item.createdBy, targetId: item.id, target: automationTargetSnapshot(item) });
  await h.store.pause(item.id);
  expect(await tap(h, 'auto.confirm')).toEqual({ ok: false, message: '#1 状态已变化，请重新查询。' });
  expect(h.store.get(item.id)?.paused).toBe(true);
});

it.each(['create', 'delete'] as const)('serializes simultaneous confirm and reject taps for a %s draft', async op => {
  const h = await harness();
  if (op === 'delete') {
    const target = await h.store.create(reminder());
    await submitDraft(h.ctx, { op, chatId: target.chatId, createdBy: target.createdBy, targetId: target.id, target: automationTargetSnapshot(target) });
  } else await submitDraft(h.ctx, reminder());
  const results = await Promise.all([tap(h, 'auto.confirm'), tap(h, 'auto.reject')]);
  expect(results).toEqual([{ ok: true, message: op === 'create' ? '已确认 #1' : '已删除 #1' }, { ok: false, message: '此确认已失效。' }]);
  expect(h.store.list()).toHaveLength(op === 'create' ? 1 : 0);
});

it('retries a stale sequence and preserves the visible body while settling in place', async () => {
  const h = await harness();
  await submitDraft(h.ctx, reminder());
  const original = h.channel.rawClient.cardkit.v1.card.update;
  const sequences: number[] = [];
  h.channel.rawClient.cardkit.v1.card.update = async params => {
    sequences.push((params as { data: { sequence: number } }).data.sequence);
    if (sequences.length === 1) return { code: 10004, msg: 'sequence invalid' };
    return original(params);
  };
  vi.useFakeTimers();
  expect(await tap(h, 'auto.confirm')).toMatchObject({ ok: true });
  await vi.runAllTimersAsync();
  expect(sequences).toHaveLength(2);
  expect(sequences[1]).toBeGreaterThan(sequences[0]!);
  expect(JSON.stringify(h.channel.updatedCards.at(-1)?.card)).toContain('Review the plan');
  expect(JSON.stringify(h.channel.updatedCards.at(-1)?.card)).toContain('已确认 #1');
  expect(h.channel.sent).toHaveLength(1);
});

it('sends one topic fallback for an applied operation when its card cannot be updated', async () => {
  const h = await harness();
  const operationId = newAutomationOperationId(automationOperationScope('synthetic', 'oc_group'), NOW);
  await submitDraft(h.ctx, { ...reminder(), operationId, cardReply: { replyTo: 'om_origin', replyInThread: true, threadId: 'omt_topic' } },
    { operationId, profile: 'synthetic', chatId: 'oc_group', fingerprint: 'a'.repeat(64) });
  h.channel.rawClient.cardkit.v1.card.update = async () => ({ code: 230026, msg: 'message recalled' });
  expect(await tap(h, 'auto.confirm')).toMatchObject({ ok: true });
  await expect.poll(() => h.channel.sent.length).toBe(2);
  expect(h.channel.sent[1]).toMatchObject({ content: { markdown: '确认卡未能更新：已确认 #1' }, options: { replyTo: 'om_fake_1', replyInThread: true } });
  expect(await tap(h, 'auto.confirm')).toMatchObject({ ok: false });
  expect(h.channel.sent).toHaveLength(2);
});

it.each(['ok', 'gone', 'link'] as const)('settles due drafts on expiry with a %s update outcome', async outcome => {
  const h = await harness();
  const draft = await submitDraft(h.ctx, reminder());
  h.setNow(NOW + AUTOMATIONS_DRAFT_TTL_MS);
  if (outcome === 'gone') h.channel.rawClient.cardkit.v1.card.update = async () => ({ code: 230026, msg: 'message recalled' });
  if (outcome === 'link') h.channel.rawClient.cardkit.v1.card.update = async () => { throw axiosErrno('ECONNRESET', 'connect ECONNRESET'); };
  await expireDraftConfirmations({ store: h.store, channel: h.channel as never });
  if (outcome === 'link') expect(h.store.getDraft(draft.draftId)).toBeDefined();
  else expect(h.store.getDraft(draft.draftId)).toBeUndefined();
  if (outcome === 'ok') expect(JSON.stringify(h.channel.updatedCards)).toContain('已过期');
  expect(h.channel.sent).toHaveLength(1);
});

it('preserves a persisted legacy draft and accepts it after restart through the common path', async () => {
  const h = await harness();
  await submitDraft(h.ctx, reminder());
  const disk = JSON.parse(await readFile(h.options.path, 'utf8'));
  // Legacy bound cards predate operation receipts and the Outbox association.
  delete disk.drafts[0].deliveryId;
  await writeFile(h.options.path, JSON.stringify(disk));
  const restarted = new AutomationsStore(h.options);
  await restarted.load();
  const ctx = { ...h.ctx, automations: restarted };
  const token = buttonToken(h.channel.sent[0]?.content, 'auto.confirm');
  expect(await handleDraftAction(ctx, { action: 'auto.confirm', token, chatId: 'oc_group', messageId: 'om_fake_1' })).toMatchObject({ ok: true });
  const again = new AutomationsStore(h.options); await again.load();
  expect(again.list()).toHaveLength(1);
  expect(again.listDrafts()).toEqual([]);
});

function tap(h: Awaited<ReturnType<typeof harness>>, action: import('../../../src/automations/action-auth').AutoCardAction,
  overrides: Partial<import('../../../src/automations/draft-confirmation').DraftActionInput> = {}, index = 0) {
  return handleDraftAction(h.ctx, { action, token: buttonToken(h.channel.sent[index]?.content, action), chatId: 'oc_group', messageId: `om_fake_${index + 1}`, ...overrides });
}

function buttonToken(card: unknown, action: string): string {
  if (card && typeof card === 'object') {
    const obj = card as Record<string, unknown>;
    if (obj.cmd === action && typeof obj.auto_token === 'string') return obj.auto_token;
    for (const value of Object.values(obj)) {
      const found = buttonToken(value, action); if (found) return found;
    }
  }
  return '';
}

function reminder(): CreateAutomationInput {
  return { taskType: 'reminder', schedule: { kind: 'one-shot', fireAt: NOW + 900_000, timezone: 'UTC' },
    timezone: 'UTC', startAt: NOW, endAt: NOW + 900_000, nextFireAt: NOW + 900_000,
    chatId: 'oc_group', createdBy: 'ou_user', name: 'Review', taskText: 'Review the plan' };
}
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'draft-confirmation-')); dirs.push(dir);
  let now = NOW;
  const options = { path: join(dir, 'automations.json'), logPath: join(dir, 'automations.log'), statusPath: join(dir, 'status.json'), now: () => now };
  const store = new AutomationsStore(options);
  const channel = createRecordingLarkChannel();
  const nonceStore = new CallbackNonceStore(join(dir, 'nonces.json')); nonces.push(nonceStore);
  const autoAuth = new AutoActionAuth({ secret: 'test-secret', nonceStore, now: () => now });
  store.draftOutbox = new Outbox({ channel: channel as never, journal: store.outboxJournal, draftCards: store, botAppId: 'cli_test', liveSweep: false });
  const scheduler = createAutomationScheduler({ store, sender: { send() {} }, notifier: { notify() {} }, botDisplayName: () => 'Synthetic', now: () => now });
  const ctx = { automations: store, automationsScheduler: scheduler, autoAuth, channel: channel as never, now: () => now };
  return { store, channel, ctx, options, setNow(value: number) { now = value; } };
}
