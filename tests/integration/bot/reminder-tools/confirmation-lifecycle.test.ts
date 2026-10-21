import type { AgentRunOptions } from '../../../../src/agent/types';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createRecordingLarkChannel } from '../../../helpers/recording-lark-channel';
import { buildToolProcess } from '../../../helpers/bridge-tool-process';
import { automationButton as button, automationClick as click } from '../../../helpers/automation-tool-harness';
import { createReminderHarness, END, FIRES, NOW, reminder, schedule } from './harness';

const sdk = vi.hoisted(() => ({ channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined }));
vi.mock('@larksuite/channel', async original => ({ ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel }));

const fsFault = vi.hoisted(() => ({ beforeRename: undefined as undefined | ((destination: string) => Promise<void>) }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (from: string, to: string) => { await fsFault.beforeRename?.(String(to)); return actual.rename(from, to); } };
});

const cleanups: Array<() => Promise<unknown>> = [];
let client: Awaited<ReturnType<typeof buildToolProcess>>;
beforeAll(async () => { client = await buildToolProcess(); }, 30000);
afterAll(async () => { await client?.cleanup(); });
afterEach(async () => { fsFault.beforeRename = undefined; for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); sdk.channel = undefined; });
const harness = createReminderHarness({ getClient: () => client, cleanup: cleanups, setChannel: channel => { sdk.channel = channel; } });

it('recovers every submitted semantic-retry ID after its response is lost and the original task is confirmed', async () => {
  const h = await harness(); let originalId = ''; let retriedId = '';
  await h.turn(async (call, opts) => {
    const first = await call('automation.create', reminder); originalId = first.data.operationId;
    retriedId = `op1.${opts.toolEnv!.LARK_BRIDGE_TOOL_SCOPE}.${NOW}.${'a'.repeat(32)}`;
    // The model loses this response and retains only the ID known before submission.
    await call('automation.create', { ...reminder, operationId: retriedId });
  });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm')));
  await h.restart();
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId: retriedId })).toMatchObject({ category: 'applied', data: { operationId: originalId, taskId: 1, applied: true } });
    expect(await call('automation.create', { ...reminder, operationId: retriedId })).toMatchObject({ category: 'applied', data: { taskId: 1 } });
  });
  expect(h.store.list()).toHaveLength(1); expect(h.store.listDrafts()).toHaveLength(0);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
}, 30000);

it.each(['delivery', 'operations', 'delivery-state', 'operation-state'] as const)('refuses malformed v2 %s data without losing the original uncertain receipt', async field => {
  const h = await harness();
  h.channel.sendErrors.send = new Error('synthetic uncertain send');
  await h.turn(async call => { expect(await call('automation.create', reminder)).toMatchObject({ category: 'unknown' }); });
  const document = JSON.parse(await readFile(h.store.getFilePath(), 'utf8'));
  if (field === 'delivery') document.drafts[0].delivery = {};
  else if (field === 'delivery-state') document.drafts[0].delivery.state = ['sending'];
  else if (field === 'operation-state') document.operations[0].state = ['received'];
  else delete document.operations;
  const corrupted = JSON.stringify(document); await writeFile(h.store.getFilePath(), corrupted);
  await expect(h.restart()).rejects.toThrow(/Invalid automation/);
  expect(await readFile(h.store.getFilePath(), 'utf8')).toBe(corrupted);
}, 30000);

it('keeps a topic-group confirmation card in the originating topic', async () => {
  const h = await harness('topic');
  await h.turn(async call => { expect(await call('automation.create', reminder)).toMatchObject({ category: 'waiting-confirmation' }); });
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!;
  expect(card.options).toMatchObject({ replyTo: 'om_synthetic_1', replyInThread: true });
}, 30000);

it('serializes end completion with a concurrent recovery query so one confirmation card is created', async () => {
  const h = await harness(); let operationId = '';
  const createdCards: unknown[] = []; const createCard = h.channel.createCard.bind(h.channel);
  h.channel.createCard = async card => { const result = await createCard(card); createdCards.push(card); return result; };
  await h.turn(async call => {
    const { endAt: _, ...withoutEnd } = schedule;
    operationId = (await call('automation.create', { ...reminder, schedule: withoutEnd })).data.operationId;
  });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.end.custom'))!.content;
  let entered!: () => void; const writing = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  cleanups.push(async () => { release(); }); let armed = true;
  fsFault.beforeRename = async destination => {
    if (armed && destination === h.store.getFilePath()) { armed = false; entered(); await gate; }
  };
  const completing = Promise.resolve(h.channel.handlers.cardAction?.(click(draft.cardMessageId!, { ...button(card, 'auto.end.custom'), end_at: '2026-10-21' })));
  void completing.catch(() => {}); await writing;
  const querying = h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'waiting-confirmation' }); });
  try { await vi.waitFor(() => expect(h.store.listDrafts()[0]?.delivery?.state).toBe('prepared'), { timeout: 12000 }); } finally { release(); }
  await completing; await querying;
  expect(createdCards).toHaveLength(2); // one end card and one confirmation card
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
}, 30000);

it('records human rejection as not-applied and keeps the same operation closed after restart', async () => {
  const h = await harness(); let operationId = '';
  await h.turn(async call => { operationId = (await call('automation.create', reminder)).data.operationId; });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  expect(await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.reject')))).toMatchObject({ toast: { type: 'success' } });
  await h.restart();
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'execution-failed', code: 'draft-closed', data: { state: 'not-applied', applied: false } });
    expect(await call('automation.create', { ...reminder, operationId })).toMatchObject({ category: 'execution-failed', code: 'draft-closed' });
  });
  expect(h.store.list()).toHaveLength(0); expect(h.store.listDrafts()).toHaveLength(0);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
}, 30000);

it('pauses an existing task immediately through the real client and queries its durable receipt after restart', async () => {
  const h = await harness();
  const item = await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  let operationId = '';
  await h.turn(async call => {
    expect((await call('automation.list')).data.tasks).toContainEqual(expect.objectContaining({ id: item.id, paused: false }));
    const result = await call('automation.pause', { id: item.id });
    expect(result).toMatchObject({ category: 'applied', data: { taskId: item.id, applied: true } });
    operationId = result.data.operationId;
    expect((await call('automation.list')).data.tasks).toContainEqual(expect.objectContaining({ id: item.id, paused: true }));
  });
  expect(h.store.listDrafts()).toHaveLength(0);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
  await h.restart();
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { taskId: item.id, applied: true } });
  });
  h.setNow(FIRES[0]!); await h.bridge.wakeAutomation(`1@${FIRES[0]}`);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('⏰ Synthetic reminder'))).toBe(false);
}, 30000);

it('resumes a paused reminder immediately, retains the original operation on retries, and dispatches the next fire', async () => {
  const h = await harness();
  const item = await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate', paused: true });
  let operationId = '';
  await h.turn(async call => {
    const result = await call('automation.resume', { id: item.id });
    expect(result).toMatchObject({ category: 'applied', data: { taskId: item.id, applied: true } });
    operationId = result.data.operationId;
    expect(await call('automation.resume', { id: item.id, operationId })).toEqual(result);
    expect((await call('automation.list')).data.tasks[0]).toMatchObject({ id: item.id, paused: false, nextFireAt: FIRES[0] });
  });
  expect(h.store.listDrafts()).toHaveLength(0);
  h.setNow(FIRES[0]!); await h.bridge.wakeAutomation(`1@${FIRES[0]}`);
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('⏰ Synthetic reminder'))).toHaveLength(1);
  await h.restart();
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { applied: true } }); });
}, 30000);

it('deletes only after the human confirms, then recovers the applied receipt without another card', async () => {
  const h = await harness();
  const item = await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  let operationId = '';
  await h.turn(async call => {
    const result = await call('automation.delete', { id: item.id });
    expect(result).toMatchObject({ category: 'waiting-confirmation', data: { applied: false, cardMessageId: expect.any(String) } });
    operationId = result.data.operationId;
    expect((await call('automation.list')).data.tasks).toHaveLength(1);
    expect(await call('automation.delete', { id: item.id, operationId })).toEqual(result);
  });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
  expect(await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm')))).toMatchObject({ toast: { type: 'success' } });
  expect(h.store.list()).toHaveLength(0);
  await h.restart();
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { taskId: item.id, applied: true } });
    expect(await call('automation.delete', { id: item.id, operationId })).toMatchObject({ category: 'applied' });
  });
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
}, 30000);

it('rejects a replacement whose schedule has no remaining fire before sending a card', async () => {
  const h = await harness();
  await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  const sundayOnly = {
    kind: 'weekly', timezone: 'Asia/Shanghai', weekdays: [7], times: [{ hour: 9, minute: 0 }],
    startAt: NOW, endAt: Date.parse('2026-10-20T16:00:00Z'),
  };
  await h.turn(async call => {
    expect(await call('automation.create', { ...reminder, schedule: sundayOnly })).toMatchObject({ category: 'validation-failed', code: 'no-remaining-fires' });
    expect(await call('automation.replace', { ...reminder, id: 1, schedule: sundayOnly })).toMatchObject({ category: 'validation-failed', code: 'no-remaining-fires' });
  });
  expect(h.store.list()).toMatchObject([{ id: 1, name: reminder.name }]);
  expect(h.store.listDrafts()).toEqual([]);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
}, 30000);

it('replaces a task with the previewed structured schedule only after confirmation and fires the replacement', async () => {
  const h = await harness();
  await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  const replacement = { ...reminder, name: 'Replacement', taskText: 'Replacement body', schedule: { ...schedule, times: [{ hour: 10, minute: 0 }] } };
  let operationId = '';
  await h.turn(async call => {
    const preview = await call('automation.preview', { taskType: 'reminder', schedule: replacement.schedule });
    expect(preview).toMatchObject({ category: 'ok', data: { totalCount: 3, nextFires: [1792375200000, 1792461600000, 1792548000000] } });
    const result = await call('automation.replace', { ...replacement, id: 1 });
    expect(result).toMatchObject({ category: 'waiting-confirmation', data: { applied: false } });
    operationId = result.data.operationId;
    expect((await call('automation.list')).data.tasks[0]).toMatchObject({ id: 1, name: reminder.name });
  });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  for (const text of ['2026-10-19 10:00', '2026-10-20 10:00', '2026-10-21 10:00', '共 3 次']) expect(JSON.stringify(card)).toContain(text);
  expect(await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm')))).toMatchObject({ toast: { type: 'success' } });
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { taskId: 2, applied: true } });
    expect((await call('automation.list')).data.tasks).toMatchObject([{ id: 2, schedule: replacement.schedule, name: 'Replacement' }]);
  });
  h.setNow(FIRES[0]!); await h.bridge.wakeAutomation(`1@${FIRES[0]}`);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('⏰'))).toBe(false);
  for (const fireAt of [1792375200000, 1792461600000, 1792548000000]) { h.setNow(fireAt); await h.bridge.wakeAutomation(`2@${fireAt}`); }
  await vi.waitFor(() => expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('⏰ Replacement'))).toHaveLength(3), { timeout: 12000 });
}, 30000);

