import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { automationButton as button, automationClick as click, createAutomationToolHarness } from '../../helpers/automation-tool-harness';
import { buildToolProcess } from '../../helpers/bridge-tool-process';
import type { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';

const sdk = vi.hoisted(() => ({ channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined }));
vi.mock('@larksuite/channel', async original => ({
  ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel,
}));

const NOW = Date.parse('2026-10-19T00:00:00Z');
const cleanup: Array<() => Promise<unknown>> = [];
let client: Awaited<ReturnType<typeof buildToolProcess>>;
beforeAll(async () => { client = await buildToolProcess(); }, 30000);
afterAll(async () => { await client?.cleanup(); });
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); sdk.channel = undefined; });

it('leaves an old final-reply create tag inert without a tool call', async () => {
  const h = await createAutomationToolHarness({ client, cleanup, initialNow: NOW, setChannel: channel => { sdk.channel = channel; } });
  await h.turn(async () => `Synthetic turn 1 completed\n<automation_proposal>{"taskType":"reminder","schedule":"10 分钟后","name":"Legacy reminder","taskText":"Legacy reminder"}</automation_proposal>`);
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(0);
  await h.turn(async call => {
    expect((await call('automation.list')).data.tasks).toEqual([]);
  });
});

it.each(['text', 'card', 'markdown'] as const)('ignores streamed, final, malformed and unfinished legacy tags in %s replies', async replyMode => {
  const h = await createAutomationToolHarness({ client, cleanup, initialNow: NOW, setChannel: channel => { sdk.channel = channel; } });
  h.cfg.preferences.messageReply = replyMode;
  await h.command('/auto new in 20m | Retained task | Retained body');
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!;
  await h.channel.handlers.cardAction?.(click(h.store.listDrafts()[0]!.cardMessageId!, button(card.content, 'auto.confirm')));
  const cardsBefore = h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm')).length;
  await h.turn(async () => [
    { type: 'text', delta: 'Synthetic turn 1 completed\n<automation_proposal>{"op":"delete","id":1}</automation_proposal>' },
    { type: 'final_text', content: 'Synthetic turn 1 completed\n<AUTOMATION_PROPOSAL>{"op":"replace","id":1,"schedule":"30 分钟后","taskText":"Obsolete replacement"}</AUTOMATION_PROPOSAL>\n<automation_proposal>not-json</automation_proposal>\n<automation_proposal>{"taskType":"reminder"' },
    { type: 'done', terminationReason: 'normal' },
  ]);
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(cardsBefore);
  expect(JSON.stringify(h.channel.sent)).not.toContain('已生成确认卡');
  await h.turn(async call => {
    expect((await call('automation.list')).data.tasks).toMatchObject([{ id: 1, name: 'Retained task', taskText: 'Retained body' }]);
  });
}, 30000);

it('retains the manual past-time correction without appending a model-protocol reply line', async () => {
  const h = await createAutomationToolHarness({ client, cleanup, initialNow: NOW, setChannel: channel => { sdk.channel = channel; } });
  await h.command('/auto new 今天 00:30 | Past reminder | Retained original intent');
  expect(h.channel.sent.map(item => item.content)).toEqual([{ markdown: '今天 00:30 已过，可改为「明天 00:30」。' }]);
  await h.turn(async call => { expect((await call('automation.list')).data.tasks).toEqual([]); });
});

it('applies exactly the real tool operation when the same turn also emits an old create tag', async () => {
  const h = await createAutomationToolHarness({ client, cleanup, initialNow: NOW, setChannel: channel => { sdk.channel = channel; } });
  let operationId = '';
  await h.turn(async call => {
    const result = await call('automation.create', { taskType: 'reminder', name: 'Current reminder', taskText: 'Deliver current reminder', schedule: { kind: 'one-shot', fireAt: NOW + 900000 } });
    expect(result.category).toBe('waiting-confirmation'); operationId = result.data.operationId;
    return 'Synthetic turn 1 completed\n<automation_proposal>{"taskType":"reminder","schedule":"30 分钟后","name":"Obsolete duplicate","taskText":"Obsolete duplicate"}</automation_proposal>';
  });
  const cards = h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'));
  expect(cards).toHaveLength(1);
  expect(JSON.stringify(h.channel.sent)).not.toContain('已生成确认卡');
  await h.channel.handlers.cardAction?.(click(h.store.listDrafts()[0]!.cardMessageId!, button(cards[0]!.content, 'auto.confirm')));
  await h.turn(async call => {
    expect((await call('automation.list')).data.tasks).toMatchObject([{ id: 1, name: 'Current reminder', taskText: 'Deliver current reminder' }]);
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { dispatchedCount: 0 } });
  });
  await h.advanceConnectedTo(NOW + 900000); await h.bridge.wakeAutomation(`1@${NOW + 900000}`);
  await vi.waitFor(() => expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('⏰ Current reminder'))).toHaveLength(1));
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { dispatchedCount: 1, executedCount: 1, deliveredCount: 1 } });
  });
}, 30000);
