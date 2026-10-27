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
import { createReminderHarness, END, FIRES, NOW, reminder, schedule, wrapListAsUserCardContent } from './harness';

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
  expect(JSON.stringify(originalCard)).toMatch(/"element_id":"lbd[0-9a-f]{17}"/);
  wrapListAsUserCardContent(h.channel);
  const preview = await h.channel.rawClient.im.v1.message.list({ params: { container_id_type: 'chat', container_id: 'oc_synthetic', page_size: 100 } }) as { data?: { items?: Array<{ msg_type?: string; body?: { content?: string } }> } };
  const listedBody = preview.data?.items?.find((item) => item.msg_type === 'interactive')?.body?.content ?? '';
  expect(listedBody).not.toContain('auto_token');
  expect(listedBody).toMatch(/"element_id":"lbd[0-9a-f]{17}"/);
  await rm(path, { recursive: true }); await rename(backup, path);
  expect(await h.restart()).toBeDefined(); // The poisoned store still reports its real persistence failure on shutdown.
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'waiting-confirmation', data: { applied: false } });
    expect(await call('automation.create', { ...reminder, operationId })).toMatchObject({ category: 'waiting-confirmation' });
  });
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(0);
  const draft = h.store.listDrafts()[0]!; expect(draftConfirmationDelivery(draft).messageId).toEqual(expect.any(String));
  await h.channel.handlers.cardAction?.(click(draftConfirmationDelivery(draft).messageId!, button(originalCard, 'auto.confirm')));
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
  await vi.waitFor(() => expect(draftConfirmationDelivery(h.store.listDrafts()[0]).messageId).toEqual(expect.any(String)), { timeout: 12000 });
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
  expect(JSON.parse(upgraded).schemaVersion).toBe(3);
  await h.restart();
  expect(await readFile(h.store.getFilePath(), 'utf8')).toBe(upgraded);
  await h.channel.handlers.cardAction?.(click(draftConfirmationDelivery(original).messageId!, button(card, 'auto.confirm')));
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
  const confirming = Promise.resolve(h.channel.handlers.cardAction?.(click(draftConfirmationDelivery(draft).messageId!, button(card, 'auto.confirm'))));
  void confirming.catch(() => {});
  await writing;
  try {
    await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).not.toMatchObject({ category: 'applied' }); });
  } finally { release(); }
  await confirming;
  await h.turn(async call => { expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { taskId: 1, applied: true } }); });
}, 30000);

