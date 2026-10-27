import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { automationButton as button, automationClick as click, createAutomationToolHarness } from '../../helpers/automation-tool-harness';
import { buildToolProcess } from '../../helpers/bridge-tool-process';
import type { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import fixture from '../../fixtures/automations/pre-tools-v1.json';
import { AUTO_INVALID_HINT } from '../../../src/automations/command';

const sdk = vi.hoisted(() => ({ channel: undefined as ReturnType<typeof createRecordingLarkChannel> | undefined }));
vi.mock('@larksuite/channel', async original => ({
  ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel,
}));

const cleanup: Array<() => Promise<unknown>> = [];
let client: Awaited<ReturnType<typeof buildToolProcess>>;
beforeAll(async () => { client = await buildToolProcess(); }, 30000);
afterAll(async () => { await client?.cleanup(); });
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); sdk.channel = undefined; });

const messages = [...fixture.cards, fixture.board].map(card => ({
  message_id: card.messageId, msg_type: 'interactive', body: { content: JSON.stringify(card.content.card) },
}));
const identityConfig = '{"default_as":"bot","strict_mode":false,"synthetic_account":"retained-profile"}\n';
async function harness() {
  return createAutomationToolHarness({ client, cleanup, initialNow: fixture.now, agentKind: 'claude', agentTasks: true,
    initialMessages: messages, setChannel: channel => { sdk.channel = channel; },
    setup: async tmp => {
      const cwd = await realpath(tmp.workspace);
      const old = JSON.parse(JSON.stringify(fixture), (_key, value) => value === '__WORKSPACE__' ? cwd : value);
      await writeFile(join(tmp.profile, 'automations.json'), JSON.stringify(old.automations));
      await writeFile(join(tmp.profile, 'callback-nonces.json'), JSON.stringify(old.nonces));
      await writeFile(join(tmp.profile, 'sessions.json'), JSON.stringify(old.sessions));
      await mkdir(join(tmp.profile, 'lark-cli'), { recursive: true });
      await writeFile(join(tmp.profile, 'lark-cli/config.json'), identityConfig);
    } });
}

it('resumes a pre-tools session with the current short contract and client while its old reply tag stays inert', async () => {
  const h = await harness();
  await h.turn(async (_call, opts) => {
    expect(opts.resumeHandle).toBe('old-synthetic-session');
    expect(opts.prompt).toContain('lark-channel-bridge tool');
    expect(opts.prompt).toContain('bridge_plugins');
    expect(opts.prompt).not.toContain('automation_proposal');
    expect(opts.prompt).not.toContain('automation.preview');
    expect(opts.toolEnv?.LARK_BRIDGE_TOOL_CLIENT).toBeTruthy();
    return 'Synthetic turn 1 completed\n<automation_proposal>{"taskType":"reminder","schedule":"10 分钟后","name":"Old history replay","taskText":"Old history replay"}</automation_proposal>';
  });
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
  await h.turn(async (call, opts) => {
    expect(opts.resumeHandle).toBe('old-synthetic-session');
    const plugins = await call('plugins.list');
    expect(plugins.data.plugins[0].id).toBe('automation');
    expect((await call('plugins.read', { skill: 'automation:automations' })).data.content).toContain('automation.create');
    expect((await call('automation.list')).data.tasks.map((task: any) => task.name)).toEqual(['Old saved reminder', 'Old saved agent', 'Old delete target', 'Old replace target']);
  });
}, 30000);

it('preserves v1 tasks and drafts while pre-deploy buttons get the existing invalid response', async () => {
  const h = await harness();
  const upgraded = await readFile(join(h.tmp.profile, 'automations.json'), 'utf8');
  expect(JSON.parse(upgraded).schemaVersion).toBe(2);
  await h.restart({ messages });
  const restarted = JSON.parse(await readFile(join(h.tmp.profile, 'automations.json'), 'utf8'));
  expect(restarted.items).toEqual(JSON.parse(upgraded).items);
  expect(restarted.drafts).toEqual(JSON.parse(upgraded).drafts);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);

  // Spec D1 permits the token format to change; the fixed fixture bytes stay original.
  expect(await h.channel.handlers.cardAction?.(click(fixture.board.messageId, button(fixture.board.content, 'auto.pause'))))
    .toEqual({ toast: { type: 'error', content: AUTO_INVALID_HINT } });
  expect(h.store.get(1)?.paused).toBe(false);
  await h.command('/auto pause 1');
  await h.turn(async call => { expect((await call('automation.list')).data.tasks[0]).toMatchObject({ id: 1, paused: true }); });
  await h.command('/auto resume 1');
  await h.turn(async call => { expect((await call('automation.list')).data.tasks[0]).toMatchObject({ id: 1, paused: false }); });

  // A normal task update refreshes the existing board with current signed buttons.
  const boardUpdates = () => h.channel.rawClient.requests.filter(item => item.method === 'cardkit.v1.card.update')
    .map(item => item.params as { path: { card_id: string }; data: { card: { data: string } } })
    .filter(item => item.path.card_id === fixture.automations.boards[0]!.cardId);
  await vi.waitFor(() => expect(boardUpdates().length).toBeGreaterThan(0));
  expect(await h.channel.handlers.cardAction?.(click(fixture.board.messageId, button(JSON.parse(boardUpdates().at(-1)!.data.card.data), 'auto.pause'))))
    .toMatchObject({ toast: { type: 'success' } });
  await h.command('/auto resume 1');

  for (const index of [0, 2, 3]) {
    const original = fixture.cards[index]!;
    expect(await h.channel.handlers.cardAction?.(click(original.messageId, button(original.content, 'auto.confirm'))))
      .toEqual({ toast: { type: 'error', content: AUTO_INVALID_HINT } });
  }
  const incomplete = fixture.cards[1]!;
  expect(await h.channel.handlers.cardAction?.(click(incomplete.messageId, { ...button(incomplete.content, 'auto.end.custom'), end_at: '2026-10-19' })))
    .toEqual({ toast: { type: 'error', content: AUTO_INVALID_HINT } });
  const afterInvalidClicks = JSON.parse(await readFile(join(h.tmp.profile, 'automations.json'), 'utf8'));
  expect(afterInvalidClicks.drafts).toEqual(restarted.drafts);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
  await h.restart();
  expect(JSON.parse(await readFile(join(h.tmp.profile, 'automations.json'), 'utf8')).drafts).toEqual(restarted.drafts);
  await h.turn(async call => {
    expect((await call('automation.list')).data.tasks).toMatchObject([
      { id: 1, name: 'Old saved reminder', nextFireAt: 1792368900000 },
      { id: 2, name: 'Old saved agent', nextFireAt: 1792369200000 },
      { id: 3, name: 'Old delete target', nextFireAt: 1792368900000 },
      { id: 4, name: 'Old replace target', nextFireAt: 1792368900000 },
    ]);
  });

  h.setScript(async (call, opts) => {
    expect(opts.promptVariant).toBe('automation');
    expect(opts.resumeHandle).toBeUndefined();
    expect(await realpath(opts.cwd!)).toBe(await realpath(h.tmp.workspace));
    expect((await call('plugins.read', { skill: 'automation:automations' })).category).toBe('ok');
    expect(await call('automation.create', {})).toMatchObject({ category: 'unavailable', code: 'automation-management-unavailable-in-run' });
    return 'Old saved agent executed using the current client';
  });
  for (const [id, fireAt] of [[1, 1792368900000], [3, 1792368900000], [4, 1792368900000], [2, 1792369200000]]) {
    await h.advanceConnectedTo(fireAt!); await h.bridge.wakeAutomation(`${id}@${fireAt}`);
    await vi.waitFor(() => expect(h.journal.get(`af:${id}@${fireAt}`)?.reply?.state).toBe('sent'), { timeout: 12000 });
    h.checkFailure();
  }
  const sent = JSON.stringify(h.channel.sent);
  for (const body of ['⏰ Old saved reminder', 'Old saved agent executed using the current client', '⏰ Old delete target', '⏰ Old replace target']) expect(sent.split(body)).toHaveLength(2);
  for (const body of ['⏰ Old pending confirmation', '⏰ Old replacement', '⏰ Old incomplete reminder']) expect(sent).not.toContain(body);
  await h.turn(async call => { expect((await call('automation.list')).data.tasks.every((task: any) => task.lastStatus === 'ok')).toBe(true); });
  expect(await readFile(join(h.tmp.profile, 'lark-cli/config.json'), 'utf8')).toBe(identityConfig);
  expect(JSON.parse(await readFile(join(h.tmp.profile, 'callback-nonces.json'), 'utf8'))['old-revoked-nonce']).toBe('revoked');
}, 60000);
