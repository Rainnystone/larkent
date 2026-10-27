import { draftConfirmationDelivery } from '../../../../src/automations/draft-confirmation';
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

const cleanups: Array<() => Promise<unknown>> = [];
let client: Awaited<ReturnType<typeof buildToolProcess>>;
beforeAll(async () => { client = await buildToolProcess(); }, 30000);
afterAll(async () => { await client?.cleanup(); });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); sdk.channel = undefined; });
const harness = createReminderHarness({ getClient: () => client, cleanup: cleanups, setChannel: channel => { sdk.channel = channel; } });

it('corrects invalid input in one real client turn, confirms as a human and fires exactly three Shanghai mornings', async () => {
  const h = await harness(); let operationId = '';
  await h.turn(async call => {
    expect(await call('automation.create', { ...reminder, schedule: { ...schedule, times: [{ hour: 99, minute: 0 }] } })).toMatchObject({ category: 'validation-failed', code: 'invalid-schedule' });
    expect(h.store.listDrafts()).toHaveLength(0);
    expect(await call('automation.preview', { taskType: 'reminder', schedule })).toMatchObject({ category: 'ok', data: { totalCount: 3, nextFires: FIRES, endAt: END } });
    const result = await call('automation.create', reminder);
    expect(result).toMatchObject({ category: 'waiting-confirmation', code: 'waiting-confirmation', data: { state: 'waiting-confirmation', applied: false } });
    operationId = result.data.operationId;
    expect(operationId).toEqual(expect.any(String));
    expect(await call('automation.operation.get', { operationId })).toMatchObject(result);
    expect(await call('automation.create', { ...reminder, operationId, confirm: true })).toMatchObject({ category: 'validation-failed' });
  });
  expect(h.store.list()).toHaveLength(0); expect(h.store.listDrafts()).toHaveLength(1);
  const draft = h.store.listDrafts()[0]!;
  expect(draft).toMatchObject({ schedule, endAt: END, nextFireAt: FIRES[0], createdBy: 'ou_synthetic' });
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  for (const text of ['2026-10-19 09:00', '2026-10-20 09:00', '2026-10-21 09:00', '2026-10-22 00:00', '共 3 次']) expect(JSON.stringify(card)).toContain(text);
  await h.channel.handlers.cardAction?.(click(draftConfirmationDelivery(draft).messageId!, button(card, 'auto.confirm')));
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { taskId: 1, applied: true, executedCount: 0 } }); });
  for (const fireAt of FIRES) { h.setNow(fireAt); await h.bridge.wakeAutomation(`1@${fireAt}`); }
  h.setNow(END); await h.bridge.wakeAutomation(`1@${END}`);
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('⏰ Synthetic reminder'))).toHaveLength(3);
  expect(h.journal.list().filter(item => item.turnId.startsWith('af:')).map(item => item.turnId)).toEqual(['af:1@1792371600000', 'af:1@1792458000000', 'af:1@1792544400000']);
  await h.restart();
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { applied: true, executedCount: 3, lastExecution: 'ok', executionState: 'completed', lastDelivery: 'sent' } }); });
}, 30000);

it('prints 共 31 次 on the confirm card for a future daily month window', async () => {
  const h = await harness();
  const month = {
    kind: 'daily',
    timezone: 'Asia/Shanghai',
    times: [{ hour: 9, minute: 0 }],
    startAt: Date.UTC(2026, 9, 21, 16, 0, 0),
    endAt: Date.UTC(2026, 10, 21, 16, 0, 0),
  };
  await h.turn(async call => {
    expect(await call('automation.preview', { taskType: 'reminder', schedule: month })).toMatchObject({
      category: 'ok',
      data: { totalCount: 31 },
    });
    expect(await call('automation.create', { ...reminder, schedule: month })).toMatchObject({
      category: 'waiting-confirmation',
    });
  });
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  expect(JSON.stringify(card)).toContain('共 31 次');
  expect(JSON.stringify(card)).not.toContain('约每月');
}, 30000);

it('completes a missing end through the existing scripted card before human confirmation', async () => {
  const h = await harness(); let operationId = '';
  await h.turn(async call => {
    const schema = await call('automation.schema');
    const daily = schema.data.operations['automation.create'].params.properties.schedule.oneOf.find((item: any) => item.properties.kind.const === 'daily');
    expect(daily.required).not.toContain('endAt');
    const { endAt: _, ...withoutEnd } = schedule;
    const result = await call('automation.create', { ...reminder, schedule: withoutEnd });
    expect(result).toMatchObject({ category: 'needs-input', code: 'missing-end-at', data: { applied: false, fields: ['schedule.endAt'], cardMessageId: expect.any(String) } });
    operationId = result.data.operationId;
  });
  let draft = h.store.listDrafts()[0]!;
  const endCard = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.end.custom'))!.content;
  const action = click(draftConfirmationDelivery(draft).messageId!, { ...button(endCard, 'auto.end.custom'), end_at: '2026-10-21' });
  expect(await h.channel.handlers.cardAction?.(action)).toMatchObject({ toast: { type: 'success' } });
  draft = h.store.listDrafts()[0]!;
  expect(draft).toMatchObject({ schedule, endAt: END, nextFireAt: FIRES[0] });
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'waiting-confirmation' }); });
  const confirmCard = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  await h.channel.handlers.cardAction?.(click(draftConfirmationDelivery(draft).messageId!, button(confirmCard, 'auto.confirm')));
  expect(h.store.list()).toHaveLength(1); expect(h.store.listDrafts()).toHaveLength(0);
  expect(h.store.list()[0]).toMatchObject({ schedule, endAt: END });
}, 30000);

