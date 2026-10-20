import { mkdir, rename, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { automationButton, automationClick, createAutomationToolHarness } from '../../helpers/automation-tool-harness';
import { buildToolProcess } from '../../helpers/bridge-tool-process';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';

const sdk = vi.hoisted(() => ({ channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined }));
vi.mock('@larksuite/channel', async original => ({ ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel }));
const NOW = Date.parse('2026-10-19T00:00:00Z');
const reminder = { taskType: 'reminder', name: 'Morning reminder', taskText: 'Synthetic morning task',
  schedule: { kind: 'daily', timezone: 'Asia/Shanghai', times: [{ hour: 9, minute: 0 }], startAt: NOW, endAt: NOW + 3 * 86400000 } };
const revised = { ...reminder, schedule: { ...reminder.schedule, times: [{ hour: 8, minute: 30 }] } };
let client: Awaited<ReturnType<typeof buildToolProcess>>;
const cleanup: Array<() => Promise<unknown>> = [];
beforeAll(async () => { client = await buildToolProcess(); }, 30000);
afterAll(async () => { await client?.cleanup(); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); sdk.channel = undefined; });
function harness() {
  return createAutomationToolHarness({ client, cleanup, initialNow: NOW, setChannel: channel => { sdk.channel = channel; } });
}
function lastConfirmation(h: Awaited<ReturnType<typeof harness>>) {
  const sent = h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm')).at(-1)!;
  return { messageId: h.store.listDrafts().at(-1)!.cardMessageId!, value: automationButton(sent.content, 'auto.confirm') };
}

it('revises a pending draft, invalidates its old card and confirms only the new schedule after restart', async () => {
  const h = await harness(); let originalId = ''; let revisionId = '';
  await h.turn(async call => { originalId = (await call('automation.create', reminder)).data.operationId; });
  const old = lastConfirmation(h);
  await h.turn(async call => {
    const result = await call('automation.create', { ...revised, supersedesOperationId: originalId });
    expect(result).toMatchObject({ category: 'waiting-confirmation' }); revisionId = result.data.operationId;
    expect(await call('automation.operation.get', { operationId: originalId })).toMatchObject({ category: 'execution-failed', code: 'draft-superseded', data: { applied: false } });
  });
  const next = lastConfirmation(h);
  await vi.waitFor(() => expect(h.channel.updatedCards.some(item => item.messageId === old.messageId && JSON.stringify(item.card).includes('已被新卡取代'))).toBe(true));
  await h.restart();
  expect(await h.channel.handlers.cardAction?.(automationClick(old.messageId, old.value))).toMatchObject({ toast: { type: 'error', content: '此确认已失效。' } });
  expect(await h.channel.handlers.cardAction?.(automationClick(next.messageId, next.value))).toMatchObject({ toast: { type: 'success' } });
  await h.turn(async call => {
    expect(await call('automation.create', { ...revised, operationId: revisionId, supersedesOperationId: originalId })).toMatchObject({ category: 'applied' });
    expect((await call('automation.list')).data.tasks).toEqual([expect.objectContaining({ name: reminder.name, schedule: revised.schedule })]);
  });
  expect(await h.channel.handlers.cardAction?.(automationClick(old.messageId, old.value))).toMatchObject({ toast: { type: 'error' } });
  expect(await h.channel.handlers.cardAction?.(automationClick(next.messageId, next.value))).toMatchObject({ toast: { type: 'error' } });
}, 30000);


it('preserves independent same-name drafts and refuses another actor, chat or profile', async () => {
  const h = await harness(); let originalId = ''; let independentId = '';
  await h.turn(async call => {
    originalId = (await call('automation.create', reminder)).data.operationId;
    independentId = (await call('automation.create', revised)).data.operationId;
  });
  await h.turn(async call => {
    expect(await call('automation.create', { ...reminder, taskText: 'Another actor', supersedesOperationId: originalId })).toMatchObject({ category: 'validation-failed', code: 'draft-supersession-conflict' });
  }, 'oc_synthetic', true, 'group', undefined, 'ou_mate');
  await h.turn(async call => {
    expect(await call('automation.create', { ...revised, supersedesOperationId: originalId })).toMatchObject({ category: 'unauthorized', code: 'operation-scope-mismatch' });
  }, 'oc_other');
  await h.restart({ profile: 'other-profile' });
  await h.turn(async call => {
    expect(await call('automation.create', { ...revised, supersedesOperationId: originalId })).toMatchObject({ category: 'unauthorized', code: 'operation-scope-mismatch' });
  });
  await h.restart({ profile: 'synthetic' });
  await h.turn(async call => {
    for (const operationId of [originalId, independentId]) expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'waiting-confirmation' });
    const result = await call('automation.create', { ...revised, taskText: 'Revised original only', supersedesOperationId: originalId });
    expect(result.category).toBe('waiting-confirmation');
    expect(await call('automation.operation.get', { operationId: independentId })).toMatchObject({ category: 'waiting-confirmation' });
  });
  expect(h.store.listDrafts()).toHaveLength(2);
}, 30000);

it('deduplicates concurrent revisions, refuses stale targets, and leaves the old draft valid on invalid input', async () => {
  const h = await harness(); let originalId = ''; let revisedId = '';
  await h.turn(async call => { originalId = (await call('automation.create', reminder)).data.operationId; });
  const old = lastConfirmation(h);
  await h.turn(async call => {
    expect(await call('automation.create', { ...revised, schedule: { ...revised.schedule, times: [{ hour: 99, minute: 0 }] }, supersedesOperationId: originalId })).toMatchObject({ category: 'validation-failed' });
    expect(await call('automation.operation.get', { operationId: originalId })).toMatchObject({ category: 'waiting-confirmation' });
    const results = await Promise.all([call('automation.create', { ...revised, supersedesOperationId: originalId }), call('automation.create', { ...revised, supersedesOperationId: originalId })]);
    expect(results[0]).toMatchObject({ category: 'waiting-confirmation' });
    expect(results[1]).toEqual(results[0]); revisedId = results[0].data.operationId;
    expect(await call('automation.create', { ...revised, name: 'Stale revision', supersedesOperationId: originalId })).toMatchObject({ category: 'validation-failed', code: 'draft-supersession-conflict' });
    expect(await call('automation.create', { ...revised, operationId: revisedId })).toMatchObject({ category: 'validation-failed', code: 'operation-conflict' });
  });
  const next = lastConfirmation(h);
  const outcomes = await Promise.all([h.channel.handlers.cardAction?.(automationClick(next.messageId, next.value)), h.channel.handlers.cardAction?.(automationClick(old.messageId, old.value))]);
  expect(outcomes).toMatchObject([{ toast: { type: 'success' } }, { toast: { type: 'error' } }]);
  await h.turn(async call => {
    expect(await call('automation.create', { ...reminder, supersedesOperationId: revisedId })).toMatchObject({ category: 'validation-failed', code: 'draft-supersession-conflict' });
    expect((await call('automation.list')).data.tasks).toHaveLength(1);
  });
}, 30000);

it('rejects a revision when human confirmation wins the race', async () => {
  const h = await harness(); let originalId = '';
  await h.turn(async call => { originalId = (await call('automation.create', reminder)).data.operationId; });
  const old = lastConfirmation(h);
  const confirmation = h.channel.handlers.cardAction?.(automationClick(old.messageId, old.value));
  await h.turn(async call => {
    expect(await call('automation.create', { ...revised, supersedesOperationId: originalId })).toMatchObject({ category: 'validation-failed', code: 'draft-supersession-conflict' });
    expect((await call('automation.list')).data.tasks).toEqual([expect.objectContaining({ schedule: reminder.schedule })]);
  });
  expect(await confirmation).toMatchObject({ toast: { type: 'success' } });
}, 30000);


it('retains the original pending draft after a failed atomic revision commit and restart', async () => {
  const h = await harness(); let originalId = '';
  await h.turn(async call => { originalId = (await call('automation.create', reminder)).data.operationId; });
  const old = lastConfirmation(h); const path = h.store.getFilePath(); const backup = `${path}.saved`;
  await rename(path, backup); await mkdir(path);
  await h.turn(async call => {
    expect(await call('automation.create', { ...revised, supersedesOperationId: originalId })).toMatchObject({ category: 'unknown' });
  });
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
  await rm(path, { recursive: true }); await rename(backup, path);
  expect(await h.restart()).toBeDefined();
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId: originalId })).toMatchObject({ category: 'waiting-confirmation' }); });
  expect(await h.channel.handlers.cardAction?.(automationClick(old.messageId, old.value))).toMatchObject({ toast: { type: 'success' } });
  await h.turn(async call => { expect((await call('automation.list')).data.tasks).toEqual([expect.objectContaining({ schedule: reminder.schedule })]); });
}, 30000);
