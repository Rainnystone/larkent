import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { openToolRun, type ToolRunContext } from '../../src/bridge-tools/server';
import { AutomationsStore } from '../../src/automations/store';
import { builtinPluginCatalog } from '../../src/plugins/catalog';
import { buildToolProcess } from '../helpers/bridge-tool-process';
import { createTmpProfile } from '../helpers/tmp-profile';

const NOW = Date.parse('2026-10-19T00:00:00Z');
let client: Awaited<ReturnType<typeof buildToolProcess>>;
const cleanup: Array<() => Promise<unknown>> = [];
beforeAll(async () => { client = await buildToolProcess(); });
afterAll(async () => { await client.cleanup(); });
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function harness(overrides: Partial<ToolRunContext> = {}) {
  const tmp = await createTmpProfile('tools-process-'); cleanup.push(tmp.cleanup);
  const store = new AutomationsStore({ path: join(tmp.profile, 'automations.json'), logPath: join(tmp.profile, 'automations.log'), statusPath: join(tmp.profile, 'status.json'), now: () => NOW });
  await store.load();
  const context: ToolRunContext = { profile: 'synthetic-profile', chatId: 'oc_synthetic', actorId: 'ou_synthetic', runType: 'im',
    availability: () => undefined, store, timezone: 'Asia/Shanghai', agentTasks: true, now: () => NOW, catalog: await builtinPluginCatalog(), ...overrides };
  const run = await openToolRun(context); cleanup.push(run.close);
  const call = async (operation: string, params = {}, env = run.env) => {
    const child = await client.call({ version: 1, operation, params }, env);
    expect(child.code).toBe(0); expect(child.stderr).toBe('');
    expect(child.stdout.trim().split('\n')).toHaveLength(1);
    return JSON.parse(child.stdout);
  };
  return { call, run, store, context };
}

it('rejects context supplied by the caller even on schema discovery', async () => {
  const h = await harness();
  expect(await h.call('automation.schema', { profile: 'other', chatId: 'oc_other', actorId: 'ou_other', runType: 'im' }))
    .toMatchObject({ category: 'validation-failed', code: 'unknown-field' });
});

it('revokes the old connection and rejects cross-run credentials while a new run remains callable', async () => {
  const old = await harness();
  const next = await harness({ profile: 'another-synthetic-profile', chatId: 'oc_other' });
  expect(await next.call('automation.list', {}, { ...next.run.env, LARK_BRIDGE_TOOL_TOKEN: old.run.env.LARK_BRIDGE_TOOL_TOKEN }))
    .toMatchObject({ category: 'unauthorized', code: 'invalid-run-credential' });
  await old.run.close();
  expect(await old.call('automation.list')).toMatchObject({ category: 'unavailable', code: 'run-connection-closed' });
  expect(await next.call('automation.list')).toMatchObject({ category: 'ok', data: { tasks: [] } });
});

it('keeps literal text intact, scopes task queries to the bound store/chat, and never exposes other chats', async () => {
  const h = await harness();
  const text = 'quotes "\'\n$(touch forbidden) ; & | `literal` <tag>';
  const item = { taskType: 'reminder' as const, schedule: { kind: 'one-shot', fireAt: NOW + 3600000 }, timezone: 'Asia/Shanghai', startAt: NOW, nextFireAt: NOW + 3600000, createdBy: 'ou_creator', name: text, taskText: text };
  await h.store.create({ ...item, chatId: 'oc_synthetic' });
  await h.store.create({ ...item, name: 'hidden task', chatId: 'oc_other' });
  const result = await h.call('automation.list');
  expect(result.data.tasks).toHaveLength(1);
  expect(result.data.tasks[0]).toMatchObject({ name: text, taskText: text });
  expect(JSON.stringify(result)).not.toContain('hidden task');
  expect(await h.call('automation.list', { chatId: 'oc_other' })).toMatchObject({ category: 'validation-failed', code: 'unknown-field' });
  expect(await h.call('plugins.read', { skill: text })).toMatchObject({ category: 'unavailable', code: 'skill-not-found-or-ambiguous' });
});

it.each([
  ['disabled', { availability: (): string => 'automations-disabled' }, 'automations-disabled'],
  ['direct message', { availability: (): string => 'automation-requires-group' }, 'automation-requires-group'],
  ['automated run', { runType: 'automation' }, 'automation-management-unavailable-in-run'],
] as const)('advertises and enforces unavailable automation in a %s context', async (_label, overrides, code) => {
  const h = await harness(overrides);
  const inspected = await h.call('plugins.inspect', { plugin: 'automation' });
  expect(inspected.data.capabilities['automation.preview']).toMatchObject({ available: false, reason: code });
  expect(await h.call('automation.preview', {})).toMatchObject({ category: 'unavailable', code });
  expect((await h.call('plugins.read', { skill: 'automations' })).category).toBe('ok');
});

it('counts a year of windowed minimum-interval fires without timing out the real client', async () => {
  const h = await harness();
  const result = await h.call('automation.preview', { taskType: 'reminder', schedule: {
    kind: 'interval', timezone: 'UTC', every: { unit: 'minutes', n: 10 },
    startAt: NOW, endAt: NOW + 365 * 86400000,
    window: { from: { hour: 9, minute: 0 }, to: { hour: 18, minute: 0 } },
  } });
  expect(result).toMatchObject({ category: 'ok', data: { totalCount: 19710 } });
}, 12000);

it.each([
  ['one-shot', { kind: 'one-shot', fireAt: NOW + 3600000 }, 1, ['2026-10-19 09:00']],
  ['daily', { kind: 'daily', timezone: 'Asia/Shanghai', times: [{ hour: 9, minute: 0 }], startAt: NOW, endAt: Date.parse('2026-10-21T16:00:00Z') }, 3, ['2026-10-19 09:00', '2026-10-20 09:00', '2026-10-21 09:00']],
  ['weekday', { kind: 'weekday', timezone: 'Asia/Shanghai', times: [{ hour: 9, minute: 0 }], startAt: NOW, endAt: Date.parse('2026-10-25T16:00:00Z') }, 5, ['2026-10-19 09:00', '2026-10-20 09:00', '2026-10-21 09:00', '2026-10-22 09:00', '2026-10-23 09:00']],
  ['weekly', { kind: 'weekly', timezone: 'Asia/Shanghai', weekdays: [1, 3], times: [{ hour: 9, minute: 0 }], startAt: NOW, endAt: Date.parse('2026-10-25T16:00:00Z') }, 2, ['2026-10-19 09:00', '2026-10-21 09:00']],
  ['interval', { kind: 'interval', timezone: 'Asia/Shanghai', every: { unit: 'hours', n: 1 }, startAt: NOW, endAt: NOW + 3 * 3600000 }, 3, ['2026-10-19 08:00', '2026-10-19 09:00', '2026-10-19 10:00']],
] as const)('previews existing %s schedules with exact exclusive boundaries and total count', async (_label, schedule, totalCount, nextFires) => {
  const h = await harness();
  expect(await h.call('automation.preview', { taskType: 'reminder', schedule })).toMatchObject({ category: 'ok', data: { timezone: 'Asia/Shanghai', totalCount, local: { nextFires } } });
  expect(h.store.list()).toEqual([]); expect(h.store.listDrafts()).toEqual([]);
});

it('gives deterministic errors for malformed, oversize and unsupported input and cannot invoke mutations', async () => {
  const h = await harness();
  for (const [input, code] of [ ['{', 'invalid-json'], ['x'.repeat(256 * 1024 + 1), 'request-too-large'] ]) {
    const child = await client.call(input, h.run.env);
    expect(child.code).toBe(0); expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toMatchObject({ category: 'validation-failed', code });
  }
  const invalidVersion = await client.call({ version: 99, operation: 'plugins.list' }, h.run.env);
  expect(JSON.parse(invalidVersion.stdout).code).toBe('unsupported-version');
  expect(await h.call('automation.create', {})).toMatchObject({ category: 'unavailable', code: 'not-implemented' });
  expect(await h.call('automation.preview', { taskType: 'reminder', schedule: { kind: 'daily', timezone: 'Mars/Synthetic', times: [{ hour: 9, minute: 0 }], startAt: NOW, endAt: NOW + 86400000 } }))
    .toMatchObject({ category: 'validation-failed', code: 'invalid-timezone' });
  const schema = await client.call('', {}, ['--schema']);
  expect(schema.stderr).toBe(''); expect(JSON.parse(schema.stdout)).toMatchObject({ required: ['version', 'operation'] });
  expect(h.store.list()).toEqual([]); expect(h.store.listDrafts()).toEqual([]);
});
