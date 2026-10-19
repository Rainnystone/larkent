import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { automationButton as button, automationClick as click, createAutomationToolHarness } from '../../helpers/automation-tool-harness';
import { buildToolProcess } from '../../helpers/bridge-tool-process';
import type { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import fixture from '../../fixtures/automations/pre-tools-v1.json';

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

it('upgrades fixed v1 tasks, unfinished drafts and original cards through confirmation, scheduling and delivery', async () => {
  const h = await harness();
  const upgraded = await readFile(join(h.tmp.profile, 'automations.json'), 'utf8');
  expect(JSON.parse(upgraded).schemaVersion).toBe(2);
  await h.restart({ messages });
  const restarted = JSON.parse(await readFile(join(h.tmp.profile, 'automations.json'), 'utf8'));
  expect(restarted.items).toEqual(JSON.parse(upgraded).items);
  expect(restarted.drafts).toEqual(JSON.parse(upgraded).drafts);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);

  // The original dashboard and manual commands still share the current task state.
  expect(await h.channel.handlers.cardAction?.(click(fixture.board.messageId, button(fixture.board.content, 'auto.pause')))).toMatchObject({ toast: { type: 'success' } });
  await h.turn(async call => { expect((await call('automation.list')).data.tasks[0]).toMatchObject({ id: 1, paused: true }); });
  await h.command('/auto resume 1');
  await h.turn(async call => { expect((await call('automation.list')).data.tasks[0]).toMatchObject({ id: 1, paused: false }); });

  for (const index of [0, 2, 3]) {
    const original = fixture.cards[index]!;
    expect(await h.channel.handlers.cardAction?.(click(original.messageId, button(original.content, 'auto.confirm')))).toMatchObject({ toast: { type: 'success' } });
  }
  const incomplete = fixture.cards[1]!;
  expect(await h.channel.handlers.cardAction?.(click(incomplete.messageId, { ...button(incomplete.content, 'auto.end.custom'), end_at: '2026-10-19' }))).toMatchObject({ toast: { type: 'success' } });
  const completion = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm') && JSON.stringify(item.content).includes('Old incomplete reminder'))!;
  expect(completion).toBeDefined();
  // Supplying the end only produces a confirmation card; no task is silently created.
  await h.turn(async call => { expect((await call('automation.list')).data.tasks.map((task: any) => task.id)).toEqual([1, 2, 5, 6]); });
  const completedDraft = h.store.listDrafts()[0]!;
  expect(await h.channel.handlers.cardAction?.(click(completedDraft.cardMessageId!, button(completion.content, 'auto.confirm')))).toMatchObject({ toast: { type: 'success' } });
  await h.restart();
  await h.turn(async call => {
    expect((await call('automation.list')).data.tasks).toMatchObject([
      { id: 1, name: 'Old saved reminder', nextFireAt: 1792368900000 },
      { id: 2, name: 'Old saved agent', nextFireAt: 1792369200000 },
      { id: 5, name: 'Old pending confirmation', nextFireAt: 1792369800000 },
      { id: 6, name: 'Old replacement', nextFireAt: 1792370400000 },
      { id: 7, name: 'Old incomplete reminder', nextFireAt: 1792371600000 },
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
  for (const [id, fireAt] of [[1, 1792368900000], [2, 1792369200000], [5, 1792369800000], [6, 1792370400000], [7, 1792371600000]]) {
    await h.advanceConnectedTo(fireAt!); await h.bridge.wakeAutomation(`${id}@${fireAt}`);
    await vi.waitFor(() => expect(h.journal.get(`af:${id}@${fireAt}`)?.reply?.state).toBe('sent'), { timeout: 12000 });
    h.checkFailure();
  }
  const sent = JSON.stringify(h.channel.sent);
  for (const body of ['⏰ Old saved reminder', 'Old saved agent executed using the current client', '⏰ Old pending confirmation', '⏰ Old replacement', '⏰ Old incomplete reminder']) expect(sent.split(body)).toHaveLength(2);
  expect(sent).not.toContain('⏰ Old delete target'); expect(sent).not.toContain('⏰ Old replace target');
  await h.turn(async call => { expect((await call('automation.list')).data.tasks.every((task: any) => task.lastStatus === 'ok')).toBe(true); });
  expect(await readFile(join(h.tmp.profile, 'lark-cli/config.json'), 'utf8')).toBe(identityConfig);
  expect(JSON.parse(await readFile(join(h.tmp.profile, 'callback-nonces.json'), 'utf8'))['old-revoked-nonce']).toBe('revoked');
}, 60000);
