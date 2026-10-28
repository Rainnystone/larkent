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
  expect(await h.channel.handlers.cardAction?.(click(draftConfirmationDelivery(draft).messageId!, button(card, 'auto.confirm')))).toMatchObject({ toast: { type: 'error' } });
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
  await h.channel.handlers.cardAction?.(click(draftConfirmationDelivery(draft).messageId!, { ...button(endCard, 'auto.end.custom'), end_at: '2026-10-21' }));
  draft = h.store.listDrafts()[0]!;
  expect(h.store.list()).toMatchObject([{ id: 1, name: reminder.name }]);
  const confirm = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  await h.channel.handlers.cardAction?.(click(draftConfirmationDelivery(draft).messageId!, button(confirm, 'auto.confirm')));
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
  expect(await h.channel.handlers.cardAction?.(click(draftConfirmationDelivery(draft).messageId!, button(card, 'auto.confirm')))).toMatchObject({ toast: { type: 'error', content: '#1 已不存在' } });
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
    try { await h.channel.handlers.cardAction?.(click(draftConfirmationDelivery(draft).messageId!, button(card, 'auto.confirm'))); } catch {}
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
    expect(await h.channel.handlers.cardAction?.(click(draftConfirmationDelivery(originalDraft).messageId!, button(originalCard, 'auto.confirm')))).toMatchObject({ toast: { type: 'success' } });
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
  await h.channel.handlers.cardAction?.(click(draftConfirmationDelivery(draft).messageId!, button(card, 'auto.confirm')));
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
  await h.channel.handlers.cardAction?.(click(draftConfirmationDelivery(deletion).messageId!, button(deleteCard, 'auto.confirm')));
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
    await h.channel.handlers.cardAction?.(click(draftConfirmationDelivery(draft).messageId!, button(originalCards[0]!.content, 'auto.confirm')));
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
  const confirming = Promise.resolve(h.channel.handlers.cardAction?.(click(draftConfirmationDelivery(draft).messageId!, button(card, 'auto.confirm'))));
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
  expect(await h.channel.handlers.cardAction?.(click(draftConfirmationDelivery(draft).messageId!, button(card, 'auto.confirm')))).toMatchObject({ toast: { type: 'error' } });
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
  await h.channel.handlers.cardAction?.(click(draftConfirmationDelivery(draft).messageId!, button(card, 'auto.confirm')));
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
  await h.journal.flush();
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
