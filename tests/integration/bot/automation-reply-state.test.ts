import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { automationButton, automationClick, createAutomationToolHarness } from '../../helpers/automation-tool-harness';
import { buildToolProcess } from '../../helpers/bridge-tool-process';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { AUTOMATIONS_DRAFT_TTL_MS } from '../../../src/automations/store';
import { join } from 'node:path';

const fsGate = vi.hoisted(() => ({ beforeRename: undefined as undefined | ((destination: string) => Promise<void>) }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (from: string, to: string) => { await fsGate.beforeRename?.(String(to)); return actual.rename(from, to); } };
});

const sdk = vi.hoisted(() => ({ channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined }));
vi.mock('@larksuite/channel', async original => ({ ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel }));

const NOW = Date.parse('2026-10-19T00:00:00Z');
const BODY = '等待确认；确认前仍按原来的 10:00 执行。';
const reminder = { taskType: 'reminder', name: 'Synthetic reminder', taskText: 'Synthetic body',
  schedule: { kind: 'one-shot', fireAt: NOW + 2 * 3600000 } };
let client: Awaited<ReturnType<typeof buildToolProcess>>;
const cleanup: Array<() => Promise<unknown>> = [];
beforeAll(async () => { client = await buildToolProcess(); }, 30000);
afterAll(async () => { await client?.cleanup(); });
afterEach(async () => { fsGate.beforeRename = undefined; for (const close of cleanup.splice(0).reverse()) await close(); sdk.channel = undefined; });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function observeTextReply(channel: ReturnType<typeof createRecordingLarkChannel>, prefix: string, checkFailure?: () => void) {
  const sent = deferred<string>();
  const send = channel.send.bind(channel);
  channel.send = async (...args) => {
    const receipt = await send(...args);
    try { checkFailure?.(); } catch (error) { sent.reject(error); }
    const content = channel.sent.at(-1)!.content as { markdown?: string };
    if (content.markdown?.startsWith(prefix)) sent.resolve(content.markdown);
    return receipt;
  };
  return sent.promise;
}

async function harness(agentKind: 'codex' | 'claude' = 'codex', replyMode: 'text' | 'markdown' | 'card' = 'text') {
  const h = await createAutomationToolHarness({ client, cleanup, initialNow: NOW, agentKind, setChannel: channel => { sdk.channel = channel; } });
  h.cfg.preferences.messageReply = replyMode;
  const sent = observeTextReply(h.channel, BODY, h.checkFailure);
  const streamed = deferred<unknown>();
  const stream = h.channel.stream.bind(h.channel);
  h.channel.stream = async (...args) => {
    const receipt = await stream(...args);
    const record = h.channel.streams.at(-1)!;
    streamed.resolve(replyMode === 'card' ? record.cardUpdates.at(-1) : record.markdownContents.at(-1));
    return receipt;
  };
  return { ...h, sent, streamed: streamed.promise };
}

async function createConfirmedReminder(h: Awaited<ReturnType<typeof harness>>) {
  const initialReply = observeTextReply(h.channel, 'Synthetic turn 1 completed');
  h.setScript(async call => { expect((await call('automation.create', reminder)).category).toBe('waiting-confirmation'); });
  await h.command('Create the initial synthetic reminder');
  await initialReply;
  h.checkFailure();
  const initial = h.store.listDrafts()[0]!;
  const initialCard = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  expect(await h.channel.handlers.cardAction?.(automationClick(initial.cardMessageId!, automationButton(initialCard, 'auto.confirm')))).toMatchObject({ toast: { type: 'success' } });
}

it.each(['markdown', 'card'] as const)('includes the settled status in the final %s stream for a delta runtime', async replyMode => {
  const h = await harness('claude', replyMode);
  h.setScript(async call => {
    const result = await call('automation.create', reminder);
    expect(result.category).toBe('waiting-confirmation');
    const card = h.channel.sent.at(-1)!.content;
    expect(await h.channel.handlers.cardAction?.(automationClick(result.data.cardMessageId, automationButton(card, 'auto.confirm')))).toMatchObject({ toast: { content: '已确认 #1' } });
    return BODY;
  });
  await h.command('Create the synthetic reminder');
  const final = await h.streamed;
  expect(JSON.stringify(final)).toContain(BODY);
  expect(JSON.stringify(final)).toContain('（回复生成期间已确认：已确认 #1）');
  h.checkFailure();
}, 30000);

it('checks confirmation again after reply persistence and before sending', async () => {
  const h = await harness();
  const staged = deferred<void>();
  const persisted = deferred<void>();
  h.setScript(async call => { expect((await call('automation.create', reminder)).category).toBe('waiting-confirmation'); return BODY; });
  fsGate.beforeRename = async destination => {
    if (destination !== join(h.tmp.profile, 'journal.json') || !h.journal.list().some(entry => entry.reply?.markdown === BODY)) return;
    fsGate.beforeRename = undefined;
    staged.resolve();
    await persisted.promise;
  };
  await h.command('Create the synthetic reminder');
  await staged.promise;
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.at(-1)!.content;
  try {
    expect(await h.channel.handlers.cardAction?.(automationClick(draft.cardMessageId!, automationButton(card, 'auto.confirm')))).toMatchObject({ toast: { content: '已确认 #1' } });
  } finally { persisted.resolve(); }
  expect(await h.sent).toBe(`${BODY}\n\n（回复生成期间已确认：已确认 #1）`);
  h.checkFailure();
}, 30000);

it('appends the resolved replacement card title when confirmation precedes the final reply', async () => {
  const h = await harness();
  await createConfirmedReminder(h);
  const waiting = deferred<void>();
  const reply = deferred<void>();
  h.setScript(async call => {
    const replaced = await call('automation.replace', { ...reminder, id: 1, schedule: { kind: 'one-shot', fireAt: NOW + 3 * 3600000 } });
    expect(replaced.category).toBe('waiting-confirmation');
    waiting.resolve();
    await reply.promise;
    return BODY;
  });
  await h.command('Replace the synthetic reminder');
  await waiting.promise;
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.at(-1)!.content;
  expect(await h.channel.handlers.cardAction?.(automationClick(draft.cardMessageId!, automationButton(card, 'auto.confirm')))).toMatchObject({ toast: { content: '已替换 #1 → #2' } });
  reply.resolve();
  expect(await h.sent).toBe(`${BODY}\n\n（回复生成期间已确认：已替换 #1 → #2）`);
  h.checkFailure();
}, 30000);

it.each(['pause', 'delete'] as const)('reports a replacement card invalidated by a target %s', async change => {
  const h = await harness();
  await createConfirmedReminder(h);
  const status = change === 'pause' ? '#1 状态已变化，请重新查询。' : '#1 已不存在';
  h.setScript(async call => {
    const replacement = await call('automation.replace', { ...reminder, id: 1, schedule: { kind: 'one-shot', fireAt: NOW + 3 * 3600000 } });
    expect(replacement.category).toBe('waiting-confirmation');
    const card = h.channel.sent.at(-1)!.content;
    const mutation = await call(`automation.${change}`, { id: 1 });
    if (change === 'delete') {
      expect(mutation.category).toBe('waiting-confirmation');
      const deletionCard = h.channel.sent.at(-1)!.content;
      expect(await h.channel.handlers.cardAction?.(automationClick(mutation.data.cardMessageId, automationButton(deletionCard, 'auto.confirm')))).toMatchObject({ toast: { content: '已删除 #1' } });
    } else expect(mutation.category).toBe('applied');
    expect(await h.channel.handlers.cardAction?.(automationClick(replacement.data.cardMessageId, automationButton(card, 'auto.confirm')))).toMatchObject({ toast: { type: 'error', content: status } });
    return BODY;
  });
  await h.command('Replace the synthetic reminder');
  const deleted = change === 'delete' ? '\n（回复生成期间已确认：已删除 #1）' : '';
  expect(await h.sent).toBe(`${BODY}\n\n（回复生成期间已失效：${status}）${deleted}`);
  h.checkFailure();
}, 30000);

it('uses the resolved card explanation when a replacement time passes before confirmation', async () => {
  const h = await harness();
  await createConfirmedReminder(h);
  const status = '今天 11:00 已过，可改为「明天 11:00」。';
  h.setScript(async call => {
    const replacement = await call('automation.replace', { ...reminder, id: 1, schedule: { kind: 'one-shot', fireAt: NOW + 3 * 3600000 } });
    expect(replacement.category).toBe('waiting-confirmation');
    const card = h.channel.sent.at(-1)!.content;
    h.setNow(NOW + 3 * 3600000 + 1);
    expect(await h.channel.handlers.cardAction?.(automationClick(replacement.data.cardMessageId, automationButton(card, 'auto.confirm')))).toMatchObject({ toast: { type: 'error', content: status } });
    await h.store.load(); // The exact card title survives the receipt's disk round trip.
    return BODY;
  });
  await h.command('Replace the synthetic reminder');
  expect(await h.sent).toBe(`${BODY}\n\n（回复生成期间已失效：${status}）`);
  h.checkFailure();
}, 30000);

it('leaves a waiting card unchanged and does not send a correction for a later click', async () => {
  const h = await harness();
  h.setScript(async call => { expect((await call('automation.create', reminder)).category).toBe('waiting-confirmation'); return BODY; });
  await h.command('Create the synthetic reminder');
  expect(await h.sent).toBe(BODY);
  const sentBeforeClick = h.channel.sent.map(item => structuredClone(item.content));
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  expect(await h.channel.handlers.cardAction?.(automationClick(draft.cardMessageId!, automationButton(card, 'auto.confirm')))).toMatchObject({ toast: { content: '已确认 #1' } });
  await h.bridge.wakeAutomation(`999@${NOW}`); // Drain the real deferred board refresh.
  await h.journal.flush();
  expect(h.channel.sent.slice(0, sentBeforeClick.length).map(item => item.content)).toEqual(sentBeforeClick);
  const added = h.channel.sent.slice(sentBeforeClick.length);
  expect(added).toHaveLength(1);
  expect(added[0]!.content).toMatchObject({ card: { header: { title: { content: '本群自动化' } } } });
  const replyId = h.journal.list().find(turn => turn.reply?.markdown === BODY)?.reply?.messageId;
  expect(replyId).toBeDefined();
  expect(h.channel.updatedCards.filter(update => update.messageId === replyId)).toEqual([]);
  h.checkFailure();
}, 30000);

it('deduplicates tracked cards and includes only the changed cards from this run', async () => {
  const h = await harness();
  h.setScript(async call => {
    const first = await call('automation.create', reminder);
    expect(first.category).toBe('waiting-confirmation');
    expect((await call('automation.operation.get', { operationId: first.data.operationId })).category).toBe('waiting-confirmation');
    const firstCard = h.channel.sent.at(-1)!.content;
    expect(await h.channel.handlers.cardAction?.(automationClick(first.data.cardMessageId, automationButton(firstCard, 'auto.confirm')))).toMatchObject({ toast: { content: '已确认 #1' } });
    const rejected = await call('automation.create', { ...reminder, name: 'Synthetic cancelled' });
    const rejectedCard = h.channel.sent.at(-1)!.content;
    expect(await h.channel.handlers.cardAction?.(automationClick(rejected.data.cardMessageId, automationButton(rejectedCard, 'auto.reject')))).toMatchObject({ toast: { content: '已取消' } });
    expect((await call('automation.create', { ...reminder, name: 'Synthetic waiting' })).category).toBe('waiting-confirmation');
    return BODY;
  });
  await h.command('Create synthetic reminders');
  expect(await h.sent).toBe(`${BODY}\n\n（回复生成期间已确认：已确认 #1）\n（回复生成期间已取消：已取消）`);
  expect(h.store.listDrafts()).toHaveLength(1);
  h.checkFailure();
}, 30000);

it('appends the cancelled card title after rejection without rewriting the model body', async () => {
  const h = await harness();
  h.setScript(async call => {
    const result = await call('automation.create', reminder);
    expect(result.category).toBe('waiting-confirmation');
    const card = h.channel.sent.at(-1)!.content;
    expect(await h.channel.handlers.cardAction?.(automationClick(result.data.cardMessageId, automationButton(card, 'auto.reject')))).toMatchObject({ toast: { content: '已取消' } });
    return BODY;
  });
  await h.command('Create the synthetic reminder');
  expect(await h.sent).toBe(`${BODY}\n\n（回复生成期间已取消：已取消）`);
  h.checkFailure();
}, 30000);

it('reports an expired confirmation without requiring another tool call', async () => {
  const h = await harness();
  h.setScript(async call => {
    expect((await call('automation.create', reminder)).category).toBe('waiting-confirmation');
    h.setNow(NOW + AUTOMATIONS_DRAFT_TTL_MS);
    return BODY;
  });
  await h.command('Create the synthetic reminder');
  expect(await h.sent).toBe(`${BODY}\n\n（回复生成期间已失效：已过期）`);
  h.checkFailure();
}, 30000);

it('keeps the expired card status after the scheduler removes the draft', async () => {
  const h = await harness();
  h.setScript(async call => {
    expect((await call('automation.create', reminder)).category).toBe('waiting-confirmation');
    await h.advanceConnectedTo(NOW + AUTOMATIONS_DRAFT_TTL_MS);
    await h.bridge.wakeAutomation(`999@${NOW + AUTOMATIONS_DRAFT_TTL_MS}`);
    expect(h.store.listDrafts()).toEqual([]);
    const updates = h.channel.rawClient.requests.filter(request => request.method === 'cardkit.v1.card.update');
    expect(JSON.stringify(updates)).toContain('已过期');
    return BODY;
  });
  await h.command('Create the synthetic reminder');
  expect(await h.sent).toBe(`${BODY}\n\n（回复生成期间已失效：已过期）`);
  h.checkFailure();
}, 30000);

it('checks confirmation after the progress-stream receipt is persisted and before the dedicated final send', async () => {
  const h = await harness('codex', 'markdown');
  const finalSendPending = deferred<void>();
  const releaseFinalSend = deferred<void>();
  const flush = h.journal.flush.bind(h.journal);
  let stagedReplyFlushed = false;
  // Call through to real persistence, controlling the later receipt-flush wait.
  const controlledFlush = vi.spyOn(h.journal, 'flush').mockImplementation(async () => {
    await flush();
    const entry = h.journal.list().find(turn => turn.reply?.markdown === BODY && turn.nonAnswerIds?.length);
    if (!entry) return;
    if (!stagedReplyFlushed) { stagedReplyFlushed = true; return; }
    controlledFlush.mockRestore();
    finalSendPending.resolve();
    await releaseFinalSend.promise;
  });
  h.setScript(async call => {
    expect((await call('automation.create', reminder)).category).toBe('waiting-confirmation');
    return [{ type: 'text', delta: 'Synthetic progress' }, { type: 'final_text', content: BODY }, { type: 'done', terminationReason: 'normal' }];
  });
  await h.command('Create the synthetic reminder');
  await finalSendPending.promise;
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  try {
    expect(await h.channel.handlers.cardAction?.(automationClick(draft.cardMessageId!, automationButton(card, 'auto.confirm')))).toMatchObject({ toast: { content: '已确认 #1' } });
  } finally { releaseFinalSend.resolve(); }
  expect(await h.sent).toBe(`${BODY}\n\n（回复生成期间已确认：已确认 #1）`);
  h.checkFailure();
}, 30000);
