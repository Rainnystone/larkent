import type { AgentRunOptions } from '../../../src/agent/types';
import { createAutomationToolHarness, automationButton as button, automationClick as click } from '../../helpers/automation-tool-harness';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, rename, rm, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { buildToolProcess } from '../../helpers/bridge-tool-process';

const fsFault = vi.hoisted(() => ({ beforeRename: undefined as undefined | ((destination: string) => Promise<void>) }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (from: string, to: string) => { await fsFault.beforeRename?.(String(to)); return actual.rename(from, to); } };
});

const sdk = vi.hoisted(() => ({ channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined }));
vi.mock('@larksuite/channel', async original => ({ ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel }));

const NOW = Date.parse('2026-10-19T00:00:00Z'); // 08:00 Shanghai
const FIRES = [1792371600000, 1792458000000, 1792544400000];
const END = 1792598400000; // October 22 00:00 Shanghai, exclusive
const schedule = { kind: 'daily', timezone: 'Asia/Shanghai', times: [{ hour: 9, minute: 0 }], startAt: NOW, endAt: END };
const reminder = { taskType: 'reminder', name: 'Synthetic reminder', taskText: 'Synthetic reminder body', schedule };
let client: Awaited<ReturnType<typeof buildToolProcess>>;
beforeAll(async () => { client = await buildToolProcess(); }, 30000);
afterAll(async () => { await client?.cleanup(); });
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { fsFault.beforeRename = undefined; for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); sdk.channel = undefined; });

async function harness(chatMode: 'group' | 'topic' = 'group', agentTasks = false, journalMaxEntries?: number) {
  return createAutomationToolHarness({ client, cleanup: cleanups, setChannel: channel => { sdk.channel = channel; }, initialNow: NOW, chatMode, agentTasks, journalMaxEntries });
}

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
  await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm')));
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { taskId: 1, applied: true, executedCount: 0 } }); });
  for (const fireAt of FIRES) { h.setNow(fireAt); await h.bridge.wakeAutomation(`1@${fireAt}`); }
  h.setNow(END); await h.bridge.wakeAutomation(`1@${END}`);
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('⏰ Synthetic reminder'))).toHaveLength(3);
  expect(h.journal.list().filter(item => item.turnId.startsWith('af:')).map(item => item.turnId)).toEqual(['af:1@1792371600000', 'af:1@1792458000000', 'af:1@1792544400000']);
  await h.restart();
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { applied: true, executedCount: 3, lastExecution: 'ok', executionState: 'completed', lastDelivery: 'sent' } }); });
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
  const action = click(draft.cardMessageId!, { ...button(endCard, 'auto.end.custom'), end_at: '2026-10-21' });
  expect(await h.channel.handlers.cardAction?.(action)).toMatchObject({ toast: { type: 'success' } });
  draft = h.store.listDrafts()[0]!;
  expect(draft).toMatchObject({ schedule, endAt: END, nextFireAt: FIRES[0] });
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'waiting-confirmation' }); });
  const confirmCard = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(confirmCard, 'auto.confirm')));
  expect(h.store.list()).toHaveLength(1); expect(h.store.listDrafts()).toHaveLength(0);
  expect(h.store.list()[0]).toMatchObject({ schedule, endAt: END });
}, 30000);

it('deduplicates overlapping semantic retries across restarts and rejects conflicts, other scopes and expired IDs', async () => {
  const h = await harness(); let operationId = ''; let waiting: any;
  await h.turn(async (call, opts) => {
    operationId = `op1.${opts.toolEnv!.LARK_BRIDGE_TOOL_SCOPE}.${NOW}.${'1'.repeat(32)}`;
    const results = await Promise.all([
      call('automation.create', { ...reminder, operationId }),
      call('automation.create', { taskText: reminder.taskText, name: reminder.name, taskType: 'reminder', schedule: { endAt: END, startAt: NOW, times: [{ minute: 0, hour: 9 }], timezone: 'Asia/Shanghai', kind: 'daily' }, operationId }),
    ]);
    waiting = results[0]; expect(waiting.category).toBe('waiting-confirmation'); expect(results[1]).toEqual(waiting);
    expect(await call('automation.create', { ...reminder, operationId, taskText: 'Different meaning' })).toMatchObject({ category: 'validation-failed', code: 'operation-conflict' });
  });
  expect(h.store.listDrafts()).toHaveLength(1);
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
  await h.restart();
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toEqual(waiting);
    expect(await call('automation.create', { ...reminder, operationId })).toEqual(waiting);
  });
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(0);
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'unauthorized', code: 'operation-scope-mismatch' });
    expect(await call('automation.create', { ...reminder, operationId })).toMatchObject({ category: 'unauthorized', code: 'operation-scope-mismatch' });
  }, 'oc_other');
  await h.restart({ profile: 'other-profile' });
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'unauthorized', code: 'operation-scope-mismatch' }); });
  h.setNow(NOW + 86400_001); await h.restart({ profile: 'synthetic' });
  await h.turn(async call => {
    expect(await call('automation.create', { ...reminder, operationId })).toMatchObject({ category: 'validation-failed', code: 'operation-expired' });
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'execution-failed', data: { state: 'not-applied', applied: false } });
    const neverSeen = operationId.slice(0, -32) + '2'.repeat(32);
    expect(await call('automation.create', { ...reminder, operationId: neverSeen })).toMatchObject({ category: 'validation-failed', code: 'operation-expired' });
  });
  expect(h.store.list()).toHaveLength(0);
}, 45000);

it('keeps an unprovable send unknown through restart and refuses recreation under a new ID', async () => {
  const h = await harness(); let operationId = '';
  const send = h.channel.send.bind(h.channel); let fail = true;
  h.channel.send = async (chatId, content, options) => {
    if (fail && (content as { cardId?: string }).cardId) { fail = false; throw new Error('synthetic connection outcome unknown'); }
    return send(chatId, content, options);
  };
  await h.turn(async call => {
    const result = await call('automation.create', reminder);
    expect(result).toMatchObject({ category: 'unknown', code: 'card-delivery-unknown', data: { applied: null } });
    operationId = result.data.operationId;
  });
  await h.restart({ messages: [] });
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'unknown', data: { operationId, applied: null } });
    expect(await call('automation.create', { ...reminder, operationId })).toMatchObject({ category: 'unknown', data: { operationId } });
    // A fresh client-generated ID must not turn uncertainty into a second operation.
    expect(await call('automation.create', reminder)).toMatchObject({ category: 'unknown', code: 'prior-operation-unknown', data: { operationId } });
  });
  expect(h.store.listDrafts()).toHaveLength(1);
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(0);
  expect(h.channel.rawClient.requests.some(item => item.method === 'im.v1.message.list')).toBe(true);
  h.setNow(NOW + 2 * 86400000); await h.restart({ messages: [] });
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'unknown', data: { operationId } });
    expect(await call('automation.create', reminder)).toMatchObject({ category: 'unknown', code: 'prior-operation-unknown', data: { operationId } });
  });
}, 30000);

it('recovers a sent card after the receipt write fails without sending a second card', async () => {
  const h = await harness(); let operationId = ''; const path = h.store.getFilePath(); const backup = `${path}.saved`;
  const send = h.channel.send.bind(h.channel); let armed = true;
  h.channel.send = async (chatId, content, options) => {
    const receipt = await send(chatId, content, options);
    if (armed && (content as { cardId?: string }).cardId) {
      armed = false; await rename(path, backup); await mkdir(path);
    }
    return receipt;
  };
  await h.turn(async call => {
    const result = await call('automation.create', reminder);
    expect(result).toMatchObject({ category: 'unknown', data: { state: 'unknown', applied: null } }); operationId = result.data.operationId;
  });
  const originalCard = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
  await rm(path, { recursive: true }); await rename(backup, path);
  expect(await h.restart()).toBeDefined(); // The poisoned store still reports its real persistence failure on shutdown.
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'waiting-confirmation', data: { applied: false } });
    expect(await call('automation.create', { ...reminder, operationId })).toMatchObject({ category: 'waiting-confirmation' });
  });
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(0);
  const draft = h.store.listDrafts()[0]!; expect(draft.cardMessageId).toEqual(expect.any(String));
  await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(originalCard, 'auto.confirm')));
  await h.restart();
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { taskId: 1, applied: true } }); });
  expect(h.store.list()).toHaveLength(1); expect(h.store.listDrafts()).toHaveLength(0);
}, 30000);

it('does not send on an initial persistence failure and proves not-applied after reloading the store', async () => {
  const h = await harness(); let operationId = ''; const path = h.store.getFilePath(); await mkdir(path);
  await h.turn(async call => {
    const result = await call('automation.create', reminder); operationId = result.data.operationId;
    expect(result).toMatchObject({ category: 'unknown', data: { applied: null, operationId: expect.any(String) } });
  });
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
  await rm(path, { recursive: true }); expect(await h.restart()).toBeDefined();
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'execution-failed', code: 'operation-not-found', data: { state: 'not-applied', applied: false } });
    expect(await call('automation.create', { ...reminder, operationId })).toMatchObject({ category: 'waiting-confirmation' });
  });
  expect(h.store.listDrafts()).toHaveLength(1);
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
}, 30000);

it.each(['create', 'delete', 'replace'] as const)('revokes a cancelled run credential while allowing its accepted %s operation to finish and be queried by a later run', async operation => {
  const h = await harness(); let env: NodeJS.ProcessEnv = {}; let operationId = '';
  if (operation !== 'create') await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  let entered!: () => void; const sending = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  cleanups.push(async () => { release(); });
  const send = h.channel.send.bind(h.channel);
  h.channel.send = async (chatId, content, options) => {
    if ((content as { cardId?: string }).cardId) { entered(); await gate; }
    return send(chatId, content, options);
  };
  const turn = h.turn(async (call, opts) => {
    env = opts.toolEnv!;
    const result = await call(`automation.${operation}`, operation === 'create' ? reminder : { ...(operation === 'replace' ? reminder : {}), id: 1 }); operationId = result.data.operationId;
    expect(result).toMatchObject({ category: 'unknown', data: { applied: null } });
  }, 'oc_synthetic', false);
  await sending;
  await h.command('/stop'); await turn;
  const denied = await client.call({ version: 1, operation: 'automation.list' }, env);
  expect(JSON.parse(denied.stdout)).toMatchObject({ category: 'unavailable', code: 'run-connection-closed' });
  release();
  await vi.waitFor(() => expect(h.store.listDrafts()[0]?.cardMessageId).toEqual(expect.any(String)), { timeout: 12000 });
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'waiting-confirmation', data: { applied: false } }); });
  expect(h.store.listDrafts()).toHaveLength(1); expect(h.store.list()).toHaveLength(operation === 'create' ? 0 : 1);
}, 30000);

it.each(['corrupted', 'timed-out'] as const)('keeps the pre-write operation ID after a %s response and recovers the sent card by querying it', async mode => {
  const h = await harness(); let operationId = '';
  await h.turn(async (call, opts) => {
    let submittedId = '';
    const proxy = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8'); submittedId = JSON.parse(body).params.operationId;
      const actual = await fetch(opts.toolEnv!.LARK_BRIDGE_TOOL_ENDPOINT!, { method: 'POST', body, headers: { authorization: request.headers.authorization! } });
      await actual.text(); if (mode === 'corrupted') response.end('{"version":99}');
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const result = JSON.parse((await client.call({ version: 1, operation: 'automation.create', params: reminder }, { ...opts.toolEnv, LARK_BRIDGE_TOOL_ENDPOINT: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/tool` })).stdout);
      expect(result).toMatchObject({ category: 'unknown', data: { operationId: submittedId, applied: null } }); operationId = submittedId;
    } finally { await new Promise<void>(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()); }); }
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'waiting-confirmation' });
  });
  expect(h.store.listDrafts()).toHaveLength(1);
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
}, 30000);

it.each(['create', 'send'] as const)('preserves a known %s rejection across restart and lets a new operation retry after that definite failure', async boundary => {
  const h = await harness(); let operationId = ''; let failed: any;
  const rejected = Object.assign(new Error('synthetic API rejection'), { response: { status: 400, data: { code: 200001, msg: 'synthetic rejection' } } });
  if (boundary === 'create') h.channel.cardErrors.create = rejected;
  else h.channel.sendErrors.send = rejected;
  await h.turn(async call => {
    failed = await call('automation.create', reminder); operationId = failed.data.operationId;
    expect(failed).toMatchObject({ category: 'execution-failed', code: 'card-send-failed', data: { applied: false, state: 'not-applied' } });
    expect(await call('automation.create', { ...reminder, operationId })).toEqual(failed);
  });
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
  await h.restart();
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toEqual(failed);
    const retried = await call('automation.create', reminder);
    expect(retried).toMatchObject({ category: 'waiting-confirmation' }); expect(retried.data.operationId).not.toBe(operationId);
  });
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
}, 30000);

it('upgrades an existing v1 manual draft and completes its original confirmation card', async () => {
  const h = await harness(); await h.command('/auto new in 15m | Synthetic legacy | Synthetic legacy body');
  const original = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  const document = JSON.parse(await readFile(h.store.getFilePath(), 'utf8'));
  document.schemaVersion = 1; delete document.operations;
  await writeFile(h.store.getFilePath(), JSON.stringify(document));
  await h.restart();
  const upgraded = await readFile(h.store.getFilePath(), 'utf8');
  expect(JSON.parse(upgraded).schemaVersion).toBe(2);
  await h.restart();
  expect(await readFile(h.store.getFilePath(), 'utf8')).toBe(upgraded);
  await h.channel.handlers.cardAction?.(click(original.cardMessageId!, button(card, 'auto.confirm')));
  await h.turn(async call => { expect(await call('automation.list')).toMatchObject({ category: 'ok', data: { tasks: [{ id: 1, taskType: 'reminder', name: 'Synthetic legacy', nextFireAt: NOW + 900000 }] } }); });
  expect(h.store.list()).toHaveLength(1); expect(h.store.listDrafts()).toHaveLength(0);
}, 30000);

it('reports offline creation as received without a sent card, then sends it once after restart', async () => {
  const h = await harness(); let operationId = '';
  h.channel.sendErrors.send = Object.assign(new Error('synthetic network failure'), { code: 'ENETDOWN' });
  await h.turn(async call => {
    expect(await call('automation.create', reminder)).toMatchObject({ category: 'unknown' });
    const result = await call('automation.create', { ...reminder, name: 'Synthetic offline reminder' });
    expect(result).toMatchObject({ category: 'unknown', code: 'card-not-sent', data: { applied: null, state: 'unknown' } }); operationId = result.data.operationId;
  }, 'oc_synthetic', false);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
  await h.restart();
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'waiting-confirmation' }); });
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
  expect(h.store.list()).toHaveLength(0);
}, 30000);

it('rejects future-dated IDs so a caller cannot bypass the submission lifetime', async () => {
  const h = await harness();
  await h.turn(async (call, opts) => {
    const operationId = `op1.${opts.toolEnv!.LARK_BRIDGE_TOOL_SCOPE}.${NOW + 86400000}.${'f'.repeat(32)}`;
    expect(await call('automation.create', { ...reminder, operationId })).toMatchObject({ category: 'validation-failed', code: 'invalid-operation-id' });
  });
  expect(h.store.listDrafts()).toHaveLength(0);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
}, 30000);

it('never reports an applied operation before the confirmation write commits', async () => {
  const h = await harness(); let operationId = '';
  await h.turn(async call => { const result = await call('automation.create', reminder); operationId = result.data.operationId; });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  let entered!: () => void; const writing = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  cleanups.push(async () => { release(); });
  let armed = true;
  fsFault.beforeRename = async destination => {
    if (armed && destination === h.store.getFilePath()) { armed = false; entered(); await gate; }
  };
  const confirming = Promise.resolve(h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm'))));
  void confirming.catch(() => {});
  await writing;
  try {
    await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).not.toMatchObject({ category: 'applied' }); });
  } finally { release(); }
  await confirming;
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { taskId: 1, applied: true } }); });
}, 30000);

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
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('⏰ Replacement'))).toHaveLength(3);
}, 30000);

it('refuses a stale replacement confirmation after a manual pause and records the conflict without creating a task', async () => {
  const h = await harness();
  await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  let operationId = '';
  await h.turn(async call => {
    const result = await call('automation.replace', { ...reminder, id: 1, name: 'Replacement' });
    expect(result.category).toBe('waiting-confirmation'); operationId = result.data.operationId;
  });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  await h.command('/auto pause 1');
  expect(await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm')))).toMatchObject({ toast: { type: 'error' } });
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'execution-failed', code: 'target-state-conflict', data: { applied: false, state: 'not-applied' } });
    expect((await call('automation.list')).data.tasks).toMatchObject([{ id: 1, paused: true, name: reminder.name }]);
  });
  expect(h.store.list()).toHaveLength(1);
}, 30000);

it('deduplicates simultaneous delete submissions and semantic retry IDs durably while rejecting changed meanings and scopes', async () => {
  const h = await harness();
  await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  let operationId = ''; let alias = ''; let waiting: any;
  await h.turn(async (call, opts) => {
    operationId = `op1.${opts.toolEnv!.LARK_BRIDGE_TOOL_SCOPE}.${NOW}.${'a'.repeat(32)}`;
    alias = operationId.slice(0, -32) + 'b'.repeat(32);
    const results = await Promise.all([call('automation.delete', { id: 1, operationId }), call('automation.delete', { id: 1, operationId }), call('automation.delete', { id: 1, operationId: alias })]);
    waiting = results[0]; expect(waiting.category).toBe('waiting-confirmation');
    expect(results[1]).toEqual(waiting); expect(results[2]).toEqual(waiting);
    expect(await call('automation.pause', { id: 1, operationId })).toMatchObject({ category: 'validation-failed', code: 'operation-conflict' });
  });
  expect(h.store.listDrafts()).toHaveLength(1);
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(1);
  await h.restart();
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId: alias })).toEqual(waiting); });
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'unauthorized', code: 'operation-scope-mismatch' });
    expect(await call('automation.delete', { id: 1 })).toMatchObject({ category: 'execution-failed', code: 'target-not-found', data: { applied: false } });
  }, 'oc_other');
  await h.restart({ profile: 'other-profile' });
  await h.turn(async call => { expect(await call('automation.delete', { id: 1, operationId })).toMatchObject({ category: 'unauthorized', code: 'operation-scope-mismatch' }); });
}, 45000);

it('completes a structured replacement missing its end without changing the old task until confirmation', async () => {
  const h = await harness();
  await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  let operationId = '';
  await h.turn(async call => {
    const { endAt: _, ...pending } = schedule;
    const result = await call('automation.replace', { ...reminder, id: 1, name: 'Replacement', schedule: pending });
    expect(result).toMatchObject({ category: 'needs-input', code: 'missing-end-at', data: { applied: false, cardMessageId: expect.any(String) } });
    operationId = result.data.operationId;
  });
  let draft = h.store.listDrafts()[0]!;
  const endCard = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.end.custom'))!.content;
  await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, { ...button(endCard, 'auto.end.custom'), end_at: '2026-10-21' }));
  draft = h.store.listDrafts()[0]!;
  expect(h.store.list()).toMatchObject([{ id: 1, name: reminder.name }]);
  const confirm = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(confirm, 'auto.confirm')));
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { taskId: 2 } });
    expect((await call('automation.list')).data.tasks).toMatchObject([{ id: 2, schedule, name: 'Replacement' }]);
  });
}, 30000);

it.each(['delete', 'replace'] as const)('keeps %s not-applied when the original target disappears before confirmation', async operation => {
  const h = await harness();
  await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  let operationId = '';
  await h.turn(async call => { const result = await call(`automation.${operation}`, { ...(operation === 'replace' ? reminder : {}), id: 1 }); operationId = result.data.operationId; expect(result.category).toBe('waiting-confirmation'); });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  await h.command('/auto delete 1');
  expect(await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm')))).toMatchObject({ toast: { type: 'error', content: '#1 已不存在' } });
  await h.restart();
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'execution-failed', code: 'target-not-found', data: { applied: false } });
    expect((await call('automation.list')).data.tasks).toEqual([]);
  });
}, 30000);

it.each(['pause', 'resume', 'delete', 'replace'] as const)('does not claim %s applied when the atomic mutation write fails and recovers the original task on restart', async operation => {
  const h = await harness();
  await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate', paused: operation === 'resume' });
  let operationId = ''; let originalDraft: ReturnType<typeof h.store.listDrafts>[number] | undefined; let originalCard: unknown;
  if (operation === 'delete' || operation === 'replace') {
    await h.turn(async call => { const result = await call(`automation.${operation}`, { ...(operation === 'replace' ? reminder : {}), id: 1 }); operationId = result.data.operationId; expect(result.category).toBe('waiting-confirmation'); });
  }
  const path = h.store.getFilePath(); const backup = `${path}.saved`;
  await rename(path, backup); await mkdir(path);
  if (operation === 'delete' || operation === 'replace') {
    const draft = h.store.listDrafts()[0]!;
    const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
    originalDraft = draft; originalCard = card;
    try { await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm'))); } catch {}
    await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'unknown', data: { applied: null } }); });
  } else {
    await h.turn(async call => { const result = await call(`automation.${operation}`, { id: 1 }); operationId = result.data.operationId; expect(result).toMatchObject({ category: 'unknown', data: { applied: null } }); });
  }
  expect(h.channel.updatedCards.some(item => JSON.stringify(item.card).includes('新任务未创建'))).toBe(false);
  await rm(path, { recursive: true }); await rename(backup, path);
  expect(await h.restart()).toBeDefined();
  await h.turn(async call => {
    const result = await call('automation.operation.get', { operationId });
    expect(result.category).not.toBe('applied');
    expect((await call('automation.list')).data.tasks).toMatchObject([{ id: 1, paused: operation === 'resume', name: reminder.name }]);
  });
  expect(h.store.list()).toHaveLength(1);
  if (originalDraft) {
    expect(await h.channel.handlers.cardAction?.(click(originalDraft.cardMessageId!, button(originalCard, 'auto.confirm')))).toMatchObject({ toast: { type: 'success' } });
    await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { taskId: operation === 'replace' ? 2 : 1 } }); });
  }
}, 30000);

it('manages existing agent tasks, preserves captured cwd, and delivers a replacement fire', async () => {
  const h = await harness('group', true);
  await h.store.create({ ...reminder, taskType: 'agent', name: 'Existing agent', taskText: 'Existing agent instruction', cwd: h.tmp.workspace, timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  let replacementId = ''; let automated: AgentRunOptions | undefined;
  await h.turn(async (call, opts) => {
    if (opts.promptVariant === 'automation') { automated = opts; return; }
    expect(await call('automation.pause', { id: 1 })).toMatchObject({ category: 'applied' });
    expect((await call('automation.list')).data.tasks[0]).toMatchObject({ taskType: 'agent', paused: true });
    expect(await call('automation.resume', { id: 1 })).toMatchObject({ category: 'applied' });
    const result = await call('automation.replace', { ...reminder, taskType: 'agent', name: 'Agent replacement', taskText: 'Synthetic replacement instruction', id: 1 });
    expect(result.category).toBe('waiting-confirmation'); replacementId = result.data.operationId;
  });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm')));
  expect(h.store.list()).toMatchObject([{ id: 2, taskType: 'agent' }]);
  expect(await realpath(h.store.list()[0]!.cwd!)).toBe(await realpath(h.tmp.workspace));
  h.setNow(FIRES[0]!); await h.bridge.wakeAutomation(`2@${FIRES[0]}`);
  await vi.waitFor(() => expect(h.journal.list().find(entry => entry.turnId === `af:2@${FIRES[0]}`)?.reply?.state).toBe('sent'), { timeout: 12000 });
  expect(await realpath(automated!.cwd!)).toBe(await realpath(h.tmp.workspace)); expect(automated?.prompt).toContain('Synthetic replacement instruction');
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId: replacementId })).toMatchObject({ category: 'applied', data: { taskId: 2, executedCount: 1 } });
    expect(await call('automation.delete', { id: 2 })).toMatchObject({ category: 'waiting-confirmation' });
  });
  const deletion = h.store.listDrafts()[0]!;
  const deleteCard = h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm')).at(-1)!.content;
  await h.channel.handlers.cardAction?.(click(deletion.cardMessageId!, button(deleteCard, 'auto.confirm')));
  expect(h.store.list()).toEqual([]);
}, 45000);

it('keeps manual and dashboard agent-task mutations immediate and agrees with subsequent client queries', async () => {
  const h = await harness('group', true);
  await h.store.create({ ...reminder, taskType: 'agent', cwd: h.tmp.workspace, timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  await h.command('/auto pause 1');
  await h.turn(async call => { expect((await call('automation.list')).data.tasks).toMatchObject([{ id: 1, taskType: 'agent', paused: true }]); });
  await h.command('/auto resume 1');
  await h.turn(async call => { expect((await call('automation.list')).data.tasks).toMatchObject([{ id: 1, paused: false, nextFireAt: FIRES[0] }]); });
  const board = h.store.getBoard('oc_synthetic')!;
  let boardCard: unknown;
  await vi.waitFor(() => {
    const updated = [...h.channel.updatedCards].reverse().find(item => JSON.stringify(item.card).includes('auto.delete'));
    const sent = [...h.channel.sent].reverse().find(item => JSON.stringify(item.content).includes('auto.delete'));
    const content = sent?.content as { card?: unknown } | undefined;
    boardCard = updated?.card ?? content?.card ?? content;
    expect(boardCard).toBeDefined();
  });
  const result = await h.channel.handlers.cardAction?.(click(board.messageId, button(boardCard, 'auto.delete')));
  expect(result).toMatchObject({ toast: { type: 'success', content: '已删除 #1' } });
  await h.turn(async call => { expect((await call('automation.list')).data.tasks).toEqual([]); });
  expect(h.store.listDrafts()).toEqual([]);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
}, 30000);

it('queries the latest revision, rejects a stale direct mutation durably, and leaves the changed task intact', async () => {
  const h = await harness();
  await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  let revision = ''; let operationId = '';
  await h.turn(async call => { revision = (await call('automation.list')).data.tasks[0].revision; expect(revision).toMatch(/^[a-f0-9]{64}$/); });
  await h.command('/auto pause 1');
  await h.turn(async call => {
    const result = await call('automation.resume', { id: 1, revision }); operationId = result.data.operationId;
    expect(result).toMatchObject({ category: 'execution-failed', code: 'target-state-conflict', data: { applied: false } });
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'execution-failed', code: 'target-state-conflict', data: { applied: false } });
    expect((await call('automation.list')).data.tasks[0]).toMatchObject({ id: 1, paused: true });
  });
  await h.restart();
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'execution-failed', code: 'target-state-conflict', data: { applied: false } }); });
}, 30000);

it.each(['pause', 'resume', 'delete', 'replace'] as const)('recovers %s after a lost real response without repeating the mutation or confirmation card', async operation => {
  const h = await harness();
  await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate', paused: operation === 'resume' });
  const params = { ...(operation === 'replace' ? { ...reminder, name: 'Replacement' } : {}), id: 1 };
  let operationId = '';
  await h.turn(async (_call, opts) => {
    const proxy = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8'); operationId = JSON.parse(body).params.operationId;
      const actual = await fetch(opts.toolEnv!.LARK_BRIDGE_TOOL_ENDPOINT!, { method: 'POST', body, headers: { authorization: request.headers.authorization! } });
      await actual.text(); response.end('{"version":99}');
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const result = JSON.parse((await client.call({ version: 1, operation: `automation.${operation}`, params }, { ...opts.toolEnv, LARK_BRIDGE_TOOL_ENDPOINT: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/tool` })).stdout);
      expect(result).toMatchObject({ category: 'unknown', data: { operationId, applied: null } });
    } finally { await new Promise<void>(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()); }); }
  });
  const originalCards = h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'));
  await h.restart();
  if (operation === 'pause' || operation === 'resume') await h.command(`/auto ${operation === 'pause' ? 'resume' : 'pause'} 1`);
  await h.turn(async call => {
    const expected = operation === 'pause' || operation === 'resume' ? 'applied' : 'waiting-confirmation';
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: expected });
    expect(await call(`automation.${operation}`, { ...params, operationId })).toMatchObject({ category: expected });
    if (operation === 'pause' || operation === 'resume') expect((await call('automation.list')).data.tasks[0].paused).toBe(operation === 'resume');
  });
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(0);
  if (operation === 'delete' || operation === 'replace') {
    const draft = h.store.listDrafts()[0]!;
    await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(originalCards[0]!.content, 'auto.confirm')));
    await h.turn(async call => {
      expect(await call(`automation.${operation}`, { ...params, operationId })).toMatchObject({ category: 'applied' });
      expect((await call('automation.list')).data.tasks).toHaveLength(operation === 'delete' ? 0 : 1);
    });
  }
}, 45000);

it.each(['delete', 'replace'] as const)('keeps uncertain %s card sends unknown through restart and prevents fresh-ID recreation', async operation => {
  const h = await harness();
  await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  const params = { ...(operation === 'replace' ? reminder : {}), id: 1 }; let operationId = '';
  const send = h.channel.send.bind(h.channel); let fail = true;
  h.channel.send = async (chatId, content, options) => {
    if (fail && (content as { cardId?: string }).cardId) { fail = false; throw new Error('synthetic unknown card send'); }
    return send(chatId, content, options);
  };
  await h.turn(async call => { const result = await call(`automation.${operation}`, params); operationId = result.data.operationId; expect(result.category).toBe('unknown'); });
  await h.restart({ messages: [] });
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'unknown', data: { applied: null } });
    expect(await call(`automation.${operation}`, params)).toMatchObject({ category: 'unknown', code: 'prior-operation-unknown', data: { operationId } });
    expect((await call('automation.list')).data.tasks).toMatchObject([{ id: 1, name: reminder.name }]);
  });
  expect(h.store.listDrafts()).toHaveLength(1);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
}, 30000);

it('does not expose a replacement as applied or list it before the real atomic rename commits', async () => {
  const h = await harness();
  await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  let operationId = '';
  await h.turn(async call => { const result = await call('automation.replace', { ...reminder, name: 'Replacement', id: 1 }); operationId = result.data.operationId; });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  let entered!: () => void; const writing = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  cleanups.push(async () => { release(); });
  let armed = true;
  fsFault.beforeRename = async destination => { if (armed && destination === h.store.getFilePath()) { armed = false; entered(); await gate; } };
  const confirming = Promise.resolve(h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm'))));
  void confirming.catch(() => {}); await writing;
  try {
    await h.turn(async call => {
      expect(await call('automation.operation.get', { operationId })).not.toMatchObject({ category: 'applied' });
      expect((await call('automation.list')).data.tasks).toMatchObject([{ id: 1, name: reminder.name }]);
    });
  } finally { release(); }
  await confirming;
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { taskId: 2 } });
    expect((await call('automation.list')).data.tasks).toMatchObject([{ id: 2, name: 'Replacement' }]);
  });
}, 30000);

it('closes a replacement whose scheduled instant has passed before confirmation and preserves the old task', async () => {
  const h = await harness();
  await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  let operationId = '';
  await h.turn(async call => {
    const result = await call('automation.replace', { ...reminder, id: 1, schedule: { kind: 'one-shot', fireAt: NOW + 900000 } });
    expect(result.category).toBe('waiting-confirmation'); operationId = result.data.operationId;
  });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  h.setNow(NOW + 900001);
  expect(await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm')))).toMatchObject({ toast: { type: 'error' } });
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'execution-failed', code: 'past-time', data: { applied: false } });
    expect((await call('automation.list')).data.tasks).toMatchObject([{ id: 1, name: reminder.name }]);
  });
}, 30000);

it('reports the same actual dispatch and delivery history through create, pause and resume receipts for an existing task', async () => {
  const h = await harness(); let creationId = ''; let pauseId = ''; let resumeId = '';
  await h.turn(async call => { creationId = (await call('automation.create', reminder)).data.operationId; });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm')));
  h.setNow(FIRES[0]!); await h.bridge.wakeAutomation(`1@${FIRES[0]}`);
  h.setNow(FIRES[0]! + 1000);
  await h.turn(async call => {
    pauseId = (await call('automation.pause', { id: 1 })).data.operationId;
    resumeId = (await call('automation.resume', { id: 1 })).data.operationId;
  });
  h.setNow(FIRES[1]!); await h.bridge.wakeAutomation(`1@${FIRES[1]}`);
  await h.turn(async call => {
    for (const operationId of [creationId, pauseId, resumeId]) expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { dispatchedCount: 2, executedCount: 2, executionHistoryComplete: true, lastExecution: 'ok' } });
  });
}, 30000);

it('rejects a malformed persisted target revision without silently dropping its stale-state guard', async () => {
  const h = await harness();
  await h.store.create({ ...reminder, taskType: 'reminder', timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  await h.turn(async call => { expect(await call('automation.replace', { ...reminder, id: 1 })).toMatchObject({ category: 'waiting-confirmation' }); });
  const document = JSON.parse(await readFile(h.store.getFilePath(), 'utf8')); document.drafts[0].target.revision = 'invalid';
  const corrupted = JSON.stringify(document); await writeFile(h.store.getFilePath(), corrupted);
  await expect(h.restart()).rejects.toThrow(/Invalid automation/);
  expect(await readFile(h.store.getFilePath(), 'utf8')).toBe(corrupted);
}, 30000);

it.each([undefined, 21])('reports a lower bound instead of a complete lifetime count for a legacy task after twenty-one real fires with journal limit %s', async maxEntries => {
  const h = await harness('group', false, maxEntries);
  const first = NOW + 3600000; const interval = { kind: 'interval', timezone: 'Asia/Shanghai', everyMs: 1800000, startAt: first, endAt: NOW + 172800000 };
  await h.store.create({ ...reminder, taskType: 'reminder', schedule: interval, timezone: 'Asia/Shanghai', startAt: first, endAt: interval.endAt, nextFireAt: first, chatId: 'oc_synthetic', createdBy: 'ou_mate' });
  for (let i = 0; i < 21; i++) { const at = first + i * 1800000; h.setNow(at); await h.bridge.wakeAutomation(`1@${at}`); }
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('⏰ Synthetic reminder'))).toHaveLength(21);
  expect(h.store.get(1)?.fireHistory).toHaveLength(20);
  let operationId = '';
  await h.turn(async call => {
    const result = await call('automation.pause', { id: 1 }); operationId = result.data.operationId;
    expect(result).toMatchObject({ category: 'applied', data: { executionScope: 'task', dispatchedCount: null, dispatchedCountLowerBound: 20, executedCount: maxEntries ? 20 : 21, executionHistoryComplete: false } });
  });
  await h.restart();
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { dispatchedCount: null, dispatchedCountLowerBound: 20, executionHistoryComplete: false } }); });
}, 30000);
