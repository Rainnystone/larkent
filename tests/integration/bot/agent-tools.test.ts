import { createAutomationToolHarness, automationButton as button, automationClick as click } from '../../helpers/automation-tool-harness';
import { writeExternalPlugin } from '../../helpers/external-plugin';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, realpath, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';
import { buildToolProcess } from '../../helpers/bridge-tool-process';

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
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); sdk.channel = undefined; });

async function harness(chatMode: 'group' | 'topic' = 'group', agentTasks = true, journalMaxEntries?: number, setup?: Parameters<typeof createAutomationToolHarness>[0]['setup']) {
  return createAutomationToolHarness({ client, cleanup: cleanups, setChannel: channel => { sdk.channel = channel; }, initialNow: NOW, chatMode, agentTasks, journalMaxEntries, setup });
}

// Each effect may include the client's ten-second transport budget and actual child-process work.
// Windows shards also run the process-heavy contract rows alongside this file.
function waitForEffect(assertion: () => void | Promise<void>) {
  return vi.waitFor(assertion, { timeout: process.platform === 'win32' ? 30000 : 12000 });
}

it.each(['group', 'topic'] as const)('creates an agent task through the real client, deduplicates it, and binds its creator and cwd on confirmation (%s)', async mode => {
  const h = await harness(mode); let operationId = '';
  const task = { ...reminder, taskType: 'agent', name: 'Synthetic agent task', taskText: 'Read the automation skill and report its title' };
  await h.turn(async call => {
    const result = await call('automation.create', task);
    expect(result).toMatchObject({ category: 'waiting-confirmation', data: { applied: false } });
    operationId = result.data.operationId;
    expect(await call('automation.create', { ...task, operationId })).toEqual(result);
    expect(await call('automation.create', { ...task, operationId, taskText: 'Different instruction' })).toMatchObject({ category: 'validation-failed', code: 'operation-conflict' });
  });
  expect(h.store.list()).toEqual([]);
  expect(h.store.listDrafts()).toHaveLength(1);
  const draft = h.store.listDrafts()[0]!;
  expect(await realpath(draft.op === 'delete' ? '' : draft.cwd!)).toBe(await realpath(h.tmp.workspace));
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  expect(await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm')))).toMatchObject({ toast: { type: 'success' } });
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { taskId: 1, executedCount: 0 } });
    expect((await call('automation.list')).data.tasks).toMatchObject([{ id: 1, taskType: 'agent', name: task.name, schedule }]);
  });
  expect(h.store.list()).toMatchObject([{ createdBy: 'ou_synthetic', chatId: 'oc_synthetic' }]);
}, 30000);

it('fires confirmed agent tasks with fresh credentials and on-demand plugin reads while denying recursive management', async () => {
  const h = await harness(); let operationId = ''; let manual: NodeJS.ProcessEnv = {};
  const task = { ...reminder, taskType: 'agent', name: 'Plugin reader' };
  await h.turn(async (call, opts) => {
    manual = opts.toolEnv!;
    operationId = (await call('automation.create', task)).data.operationId;
  });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm')));
  const credentials = [manual.LARK_BRIDGE_TOOL_TOKEN]; const automatic: NodeJS.ProcessEnv[] = [];
  h.setScript(async (call, opts) => {
    expect(opts.promptVariant).toBe('automation');
    const instructions: string[] = JSON.parse(/<bridge_instructions>\n(.*?)\n<\/bridge_instructions>/s.exec(opts.prompt)![1]!);
    expect(instructions.some(text => text.startsWith('<bridge_plugins>'))).toBe(true);
    expect(instructions.join('\n')).toContain('"runType":"automation"');
    expect(opts.prompt).not.toContain('automation.preview');
    expect(opts.prompt).not.toContain('automation:automations');
    expect(opts.prompt).toContain('ou_synthetic');
    expect(await realpath(opts.cwd!)).toBe(await realpath(h.tmp.workspace));
    expect(opts.toolEnv?.LARK_BRIDGE_TOOL_TOKEN).toBeTruthy();
    expect(credentials).not.toContain(opts.toolEnv!.LARK_BRIDGE_TOOL_TOKEN);
    credentials.push(opts.toolEnv!.LARK_BRIDGE_TOOL_TOKEN); automatic.push(opts.toolEnv!);
    const wrongCredential = await client.call({ version: 1, operation: 'plugins.list' }, { ...opts.toolEnv, LARK_BRIDGE_TOOL_TOKEN: manual.LARK_BRIDGE_TOOL_TOKEN });
    expect(JSON.parse(wrongCredential.stdout)).toMatchObject({ category: 'unauthorized', code: 'invalid-run-credential' });
    const listed = await call('plugins.list');
    expect(listed.data.plugins[0].id).toBe('automation');
    const inspected = await call('plugins.inspect', { plugin: listed.data.plugins[0].id });
    for (const op of ['create', 'replace', 'delete', 'pause', 'resume']) {
      expect(inspected.data.capabilities[`automation.${op}`]).toMatchObject({ available: false, reason: 'automation-management-unavailable-in-run' });
      expect(await call(`automation.${op}`, op === 'create' ? task : { id: 1 })).toMatchObject({ category: 'unavailable', code: 'automation-management-unavailable-in-run' });
    }
    const read = await call('plugins.read', { skill: inspected.data.skills[0].id });
    expect(read.category).toBe('ok'); expect(read.data.content).toContain('automation.preview');
    return `Read plugin: ${inspected.data.skills[0].id}; ${read.data.content.includes('automation.preview')}`;
  });
  for (const fireAt of FIRES.slice(0, 2)) {
    await h.advanceConnectedTo(fireAt); await h.bridge.wakeAutomation(`1@${fireAt}`);
    await waitForEffect(() => expect(h.journal.get(`af:1@${fireAt}`)?.reply?.state).toBe('sent'));
    h.checkFailure();
    expect(h.journal.get(`af:1@${fireAt}`)?.outcome?.kind).toBe('completed');
    expect(JSON.parse((await client.call({ version: 1, operation: 'plugins.list' }, automatic.at(-1)!)).stdout)).toMatchObject({ category: 'unavailable', code: 'run-connection-closed' });
  }
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('Read plugin: automation:automations; true'))).toHaveLength(2);
  const deliveries = h.channel.snapshotCalls().filter(item => item.op === 'send' && JSON.stringify(item.content).includes('Read plugin:'));
  expect(deliveries).toEqual([expect.objectContaining({ chatId: 'oc_synthetic' }), expect.objectContaining({ chatId: 'oc_synthetic' })]);
  expect(h.store.list()).toHaveLength(1); expect(h.store.listDrafts()).toEqual([]);
  await h.turn(async (call, opts) => {
    expect(opts.promptVariant).not.toBe('automation');
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { executedCount: 2, lastExecution: 'ok' } });
  }, 'oc_synthetic', true, 'group', h.journal.get(`af:1@${FIRES[1]}`)?.reply?.messageId);
}, 45000);

it('keeps creation applied when a run fails and reports runtime failure separately from delivered failure notice', async () => {
  const h = await harness(); let operationId = '';
  await h.turn(async call => { operationId = (await call('automation.create', { ...reminder, taskType: 'agent' })).data.operationId; });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm')));
  h.setScript(async call => {
    expect((await call('plugins.read', { skill: 'automations' })).category).toBe('ok');
    return [{ type: 'error', message: 'synthetic authorization denied', terminationReason: 'failed' }];
  });
  await h.advanceConnectedTo(FIRES[0]!); await h.bridge.wakeAutomation(`1@${FIRES[0]}`); h.checkFailure();
  await waitForEffect(() => expect(h.journal.get(`af:1@${FIRES[0]}`)?.reply?.state).toBe('sent'));
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: {
      applied: true, dispatchedCount: 1, executedCount: 0, failedCount: 1, deliveredCount: 1, lastExecution: 'failed', lastDelivery: 'sent',
    } });
  });
  expect(h.store.list()).toMatchObject([{ id: 1, taskType: 'agent', lastStatus: 'failed', paused: false }]);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('自动化任务中断'))).toBe(true);
}, 30000);

it('rejects agent creation in the same turn when its captured working directory becomes unavailable', async () => {
  const h = await harness();
  await h.turn(async call => {
    await rename(h.tmp.workspace, `${h.tmp.workspace}-moved`);
    expect(await call('automation.create', { ...reminder, taskType: 'agent' })).toMatchObject({ category: 'unavailable', code: 'agent-cwd-unavailable' });
    expect((await call('automation.list')).data.tasks).toEqual([]);
  });
  expect(h.store.listDrafts()).toEqual([]);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
}, 30000);

it('rejects an agent replacement when the captured working directory is gone', async () => {
  const h = await harness();
  await h.store.create({
    ...reminder, taskType: 'agent', cwd: h.tmp.workspace, timezone: 'Asia/Shanghai',
    startAt: NOW, endAt: END, nextFireAt: FIRES[0]!, chatId: 'oc_synthetic', createdBy: 'ou_mate',
  });
  await h.turn(async call => {
    await rename(h.tmp.workspace, `${h.tmp.workspace}-moved`);
    expect(await call('automation.replace', {
      ...reminder, taskType: 'agent', name: 'Agent replacement', taskText: 'Synthetic replacement instruction', id: 1,
    })).toMatchObject({ category: 'unavailable', code: 'agent-cwd-unavailable' });
  });
  expect(h.store.list()).toHaveLength(1);
  expect(h.store.listDrafts()).toEqual([]);
  expect(h.channel.sent.some(item => JSON.stringify(item.content).includes('auto.confirm'))).toBe(false);
}, 30000);

it('does not reuse an agent replacement drafted from a different workspace', async () => {
  const h = await harness();
  const other = join(h.tmp.root, 'other-workspace');
  await mkdir(other);
  await h.store.create({
    ...reminder, taskType: 'agent', name: 'Existing agent', taskText: 'Existing agent instruction',
    cwd: h.tmp.workspace, timezone: 'Asia/Shanghai', startAt: NOW, endAt: END, nextFireAt: FIRES[0]!,
    chatId: 'oc_synthetic', createdBy: 'ou_mate',
  });
  const replacement = { ...reminder, taskType: 'agent', name: 'Agent replacement', taskText: 'Synthetic replacement instruction', id: 1 };
  let firstId = '';
  await h.turn(async call => {
    const result = await call('automation.replace', replacement);
    expect(result).toMatchObject({ category: 'waiting-confirmation' });
    firstId = result.data.operationId;
  });
  const first = h.store.listDrafts()[0]!;
  expect(first.op).not.toBe('delete');
  expect(await realpath(first.op === 'delete' ? '' : first.cwd!)).toBe(await realpath(h.tmp.workspace));
  h.cfg.workspaces.default = other;
  await h.turn(async call => {
    const result = await call('automation.replace', replacement);
    expect(result).toMatchObject({ category: 'waiting-confirmation' });
    expect(result.data.operationId).not.toBe(firstId);
  });
  const drafts = h.store.listDrafts();
  expect(drafts).toHaveLength(2);
  const cwds = await Promise.all(drafts.map(async draft => realpath(draft.op === 'delete' ? '' : draft.cwd!)));
  expect(new Set(cwds).size).toBe(2);
  expect(h.channel.sent.filter(item => JSON.stringify(item.content).includes('auto.confirm'))).toHaveLength(2);
}, 30000);

it('reports an empty successful run before delivery and recovers its staged result after restart without rerunning', async () => {
  const h = await harness(); let operationId = ''; let fires = 0;
  await h.turn(async call => { operationId = (await call('automation.create', { ...reminder, taskType: 'agent' })).data.operationId; });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm')));
  const send = h.channel.send.bind(h.channel);
  h.channel.send = async (chat, content, options) => {
    if (JSON.stringify(content).includes('agent 没有给出文字结果')) throw Object.assign(new Error('synthetic delivery disconnected'), { code: 'ENETUNREACH' });
    return send(chat, content, options);
  };
  h.setScript(async call => {
    fires++;
    expect((await call('plugins.list')).category).toBe('ok');
    return [{ type: 'done', terminationReason: 'normal' }];
  });
  await h.advanceConnectedTo(FIRES[0]!); await h.bridge.wakeAutomation(`1@${FIRES[0]}`); h.checkFailure();
  await waitForEffect(() => expect(h.journal.get(`af:1@${FIRES[0]}`)?.reply?.state).toBe('staged'));
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { executedCount: 1, failedCount: 0, deliveredCount: 0, lastExecution: 'ok', executionState: 'completed', lastDelivery: 'staged' } });
  });
  await h.restart();
  await waitForEffect(() => expect(h.channel.sent.some(row => JSON.stringify(row.content).includes('agent 没有给出文字结果'))).toBe(true));
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { executedCount: 1, deliveredCount: 1, lastExecution: 'ok', lastDelivery: 'sent' } });
  });
  expect(fires).toBe(1);
}, 30000);

it('exposes a running automatic task then revokes its client on stop and preserves the applied creation receipt', async () => {
  const h = await harness(); let operationId = ''; let automatic: NodeJS.ProcessEnv = {};
  await h.turn(async call => { operationId = (await call('automation.create', { ...reminder, taskType: 'agent' })).data.operationId; });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm')));
  let ready = false;
  h.setScript(async (call, opts, stopped) => {
    automatic = opts.toolEnv!;
    expect((await call('plugins.list')).category).toBe('ok'); ready = true;
    await stopped;
    expect(JSON.parse((await client.call({ version: 1, operation: 'plugins.list' }, automatic)).stdout)).toMatchObject({ category: 'unavailable', code: 'run-connection-closed' });
    return [{ type: 'done', terminationReason: 'interrupted' }];
  });
  await h.advanceConnectedTo(FIRES[0]!); const waking = h.bridge.wakeAutomation(`1@${FIRES[0]}`);
  await waitForEffect(() => expect(ready).toBe(true));
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { dispatchedCount: 1, executedCount: 0, executionState: 'running', lastExecution: 'pending', lastDelivery: 'pending' } });
  });
  await h.bridge.disconnect(); await waking; h.checkFailure();
  expect(JSON.parse((await client.call({ version: 1, operation: 'plugins.list' }, automatic)).stdout)).toMatchObject({ category: 'unavailable', code: 'run-connection-closed' });
  await h.restart();
  await h.turn(async call => {
    expect(await call('automation.operation.get', { operationId })).toMatchObject({ category: 'applied', data: { applied: true, executedCount: 0, failedCount: 1, executionState: 'interrupted', lastExecution: 'failed' } });
  });
}, 30000);

it.each(['agent-disabled', 'automation-disabled', 'p2p'] as const)('reports unavailable agent creation without ghost tasks or cards (%s)', async mode => {
  const h = await harness('group', mode !== 'agent-disabled');
  await h.turn(async call => {
    if (mode === 'automation-disabled') h.cfg.automations.enabled = false;
    const code = mode === 'agent-disabled' ? 'agent-tasks-disabled' : mode === 'p2p' ? 'automation-requires-group' : 'automations-disabled';
    expect(await call('automation.create', { ...reminder, taskType: 'agent' })).toMatchObject({ category: 'unavailable', code });
    if (mode === 'agent-disabled') expect((await call('automation.schema')).data.operations['automation.create'].params.properties.taskType.enum).toEqual(['reminder']);
  }, 'oc_synthetic', true, mode === 'p2p' ? 'p2p' : 'group');
  expect(h.store.list()).toEqual([]); expect(h.store.listDrafts()).toEqual([]);
  expect(h.channel.sent.some(row => JSON.stringify(row.content).includes('auto.confirm'))).toBe(false);
}, 30000);

it('uses the deployment plugin snapshot for automatic fires and loads a new version only after restart', async () => {
  let first = ''; let next = ''; let reference = '';
  const h = await harness('group', true, undefined, async tmp => {
    first = await writeExternalPlugin(join(tmp.root, 'fixture-v1'));
    next = await writeExternalPlugin(join(tmp.root, 'fixture-v2'), '2.0.0', 7);
    await writeFile(join(tmp.root, 'plugins.json'), JSON.stringify({ schemaVersion: 1, packages: [first] }));
  });
  await h.turn(async call => {
    reference = (await call('plugins.read', { skill: 'calculate' })).data.source.reference;
    expect((await call('automation.create', { ...reminder, taskType: 'agent' })).category).toBe('waiting-confirmation');
  });
  const draft = h.store.listDrafts()[0]!;
  const card = h.channel.sent.find(item => JSON.stringify(item.content).includes('auto.confirm'))!.content;
  await h.channel.handlers.cardAction?.(click(draft.cardMessageId!, button(card, 'auto.confirm')));
  await writeFile(join(h.tmp.root, 'plugins.json'), JSON.stringify({ schemaVersion: 1, packages: [next] }));
  const runWithVersion = (version: string, expected: { result: number; doubled: number }) => h.setScript(async (call, opts) => {
    expect(opts.prompt).toContain('Calculate a synthetic fixture value');
    expect(opts.prompt).not.toContain('Read data.json');
    if (version === '2.0.0') expect(await call('plugins.read', { skill: 'calculate', reference })).toMatchObject({ category: 'unavailable', code: 'stale-plugin-reference' });
    const script = await call('plugins.read', { skill: 'calculate', resource: 'skills/calculate/scripts/value.mjs' });
    expect(script).toMatchObject({ category: 'ok', data: { source: { version } } });
    const actual = await promisify(execFile)(process.execPath, [script.data.source.path], { cwd: opts.cwd });
    expect(JSON.parse(actual.stdout)).toEqual(expected);
    return `Automatic fixture value: ${JSON.parse(actual.stdout).result}`;
  });
  runWithVersion('1.0.0', { result: 42, doubled: 84 }); await h.advanceConnectedTo(FIRES[0]!); await h.bridge.wakeAutomation(`1@${FIRES[0]}`);
  await waitForEffect(() => expect(h.journal.get(`af:1@${FIRES[0]}`)?.reply?.state).toBe('sent')); h.checkFailure();
  expect(h.channel.sent.some(row => JSON.stringify(row.content).includes('Automatic fixture value: 42'))).toBe(true);
  await h.restart(); runWithVersion('2.0.0', { result: 7, doubled: 14 }); await h.advanceConnectedTo(FIRES[1]!); await h.bridge.wakeAutomation(`1@${FIRES[1]}`);
  await waitForEffect(() => expect(h.journal.get(`af:1@${FIRES[1]}`)?.reply?.state).toBe('sent')); h.checkFailure();
  expect(h.channel.sent.some(row => JSON.stringify(row.content).includes('Automatic fixture value: 7'))).toBe(true);
}, 30000);
