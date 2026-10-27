import { draftConfirmationDelivery } from '../../../src/automations/draft-confirmation';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { automationButton, automationClick, createAutomationToolHarness } from '../../helpers/automation-tool-harness';
import { buildToolProcess } from '../../helpers/bridge-tool-process';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
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
  expect(await h.channel.handlers.cardAction?.(automationClick(draftConfirmationDelivery(initial).messageId!, automationButton(initialCard, 'auto.confirm')))).toMatchObject({ toast: { type: 'success' } });
}

it('sends the reply body byte-for-byte when a draft is confirmed during generation', async () => {
  const h = await harness();
  h.setScript(async call => {
    const result = await call('automation.create', reminder);
    expect(result.category).toBe('waiting-confirmation');
    const card = h.channel.sent.at(-1)!.content;
    expect(await h.channel.handlers.cardAction?.(automationClick(result.data.cardMessageId, automationButton(card, 'auto.confirm')))).toMatchObject({ toast: { content: '已确认 #1' } });
    return BODY;
  });
  await h.command('Create the synthetic reminder');
  expect(await h.sent).toBe(BODY);
  h.checkFailure();
}, 30000);

it('sends the reply body byte-for-byte when confirmation lands during reply persistence', async () => {
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
    expect(await h.channel.handlers.cardAction?.(automationClick(draftConfirmationDelivery(draft).messageId!, automationButton(card, 'auto.confirm')))).toMatchObject({ toast: { content: '已确认 #1' } });
  } finally { persisted.resolve(); }
  expect(await h.sent).toBe(BODY);
  h.checkFailure();
}, 30000);

it('sends the reply body byte-for-byte when a replacement is confirmed before the final reply', async () => {
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
  expect(await h.channel.handlers.cardAction?.(automationClick(draftConfirmationDelivery(draft).messageId!, automationButton(card, 'auto.confirm')))).toMatchObject({ toast: { content: '已替换 #1 → #2' } });
  reply.resolve();
  expect(await h.sent).toBe(BODY);
  h.checkFailure();
}, 30000);

it.each(['markdown', 'card'] as const)('streams the reply body without a confirmation notice in %s mode for a delta runtime', async replyMode => {
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
  expect(JSON.stringify(final)).not.toContain('回复生成期间');
  if (replyMode === 'markdown') expect(final).toBe(BODY);
  h.checkFailure();
}, 30000);

it('sends the reply body byte-for-byte when confirmation lands between the progress receipt and the dedicated final send', async () => {
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
    expect(await h.channel.handlers.cardAction?.(automationClick(draftConfirmationDelivery(draft).messageId!, automationButton(card, 'auto.confirm')))).toMatchObject({ toast: { content: '已确认 #1' } });
  } finally { releaseFinalSend.resolve(); }
  expect(await h.sent).toBe(BODY);
  h.checkFailure();
}, 30000);

it('replies once to the confirmation card when a confirmed card cannot be updated in place', async () => {
  const h = await harness();
  h.setScript(async call => { expect((await call('automation.create', reminder)).category).toBe('waiting-confirmation'); return BODY; });
  await h.command('Create the synthetic reminder');
  expect(await h.sent).toBe(BODY);
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  const update = h.channel.rawClient.cardkit.v1.card.update.bind(h.channel.rawClient.cardkit.v1.card);
  const cardId = h.store.getDraftCardReceipt(draft.draftId)?.cardId;
  h.channel.rawClient.cardkit.v1.card.update = async params => (params as { path?: { card_id?: string } }).path?.card_id === cardId
    ? { code: 10004, msg: 'sequence invalid' } : update(params);
  expect(await h.channel.handlers.cardAction?.(automationClick(draftConfirmationDelivery(draft).messageId!, automationButton(card, 'auto.confirm')))).toMatchObject({ toast: { content: '已确认 #1' } });
  await vi.waitFor(() => {
    expect(h.channel.sent.filter(item => (item.content as { markdown?: string }).markdown === '确认卡未能更新：已确认 #1')
      .map(item => (item.options as { replyTo?: string }).replyTo)).toEqual([draftConfirmationDelivery(draft).messageId]);
  }, { timeout: 10000 }); // Transient update failures retry with 1 s + 2 s backoff first.
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
  expect(await h.channel.handlers.cardAction?.(automationClick(draftConfirmationDelivery(draft).messageId!, automationButton(card, 'auto.confirm')))).toMatchObject({ toast: { content: '已确认 #1' } });
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
