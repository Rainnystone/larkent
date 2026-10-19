import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { openToolRun, type ToolRunContext } from '../../src/bridge-tools/server';
import { AutomationsStore } from '../../src/automations/store';
import { builtinPluginCatalog, PluginCatalog } from '../../src/plugins/catalog';
import { buildToolProcess, runToolProcess } from '../helpers/bridge-tool-process';
import { createTmpProfile } from '../helpers/tmp-profile';

const NOW = Date.parse('2026-10-19T00:00:00Z');
// Several sequential real Node clients need more than the default 5 seconds on hosted Windows.
const MULTI_CLIENT_TIMEOUT_MS = 20_000;
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

it('provides an absolute common client launcher that works from an unrelated workspace', async () => {
  const h = await harness();
  const launcher = h.run.env.LARK_BRIDGE_TOOL_CLIENT;
  expect(launcher, 'a source checkout must not require a globally installed bridge command').toEqual(expect.any(String));
  const result = await runToolProcess(launcher!, JSON.stringify({ version: 1, operation: 'plugins.read', params: { skill: 'automation:automations' } }), h.run.env, [], client.directory);
  expect(result.code).toBe(0); expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({ category: 'ok', data: { source: { plugin: 'automation' } } });
});

it('resolves the packaged host launcher and built-in content from the installed layout without a checkout cwd', async () => {
  const host = await client.startHost(); cleanup.push(host.close);
  expect(await realpath(host.env.LARK_BRIDGE_TOOL_CLIENT!)).toBe(await realpath(join(client.directory, 'bin/lark-channel-bridge.mjs')));
  const result = await runToolProcess(host.env.LARK_BRIDGE_TOOL_CLIENT!, JSON.stringify({ version: 1, operation: 'plugins.read', params: { skill: 'automation:automations' } }), host.env, [], tmpdir());
  expect(result.code).toBe(0); expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({ category: 'ok', data: { content: expect.stringContaining('automation.preview'), source: { plugin: 'automation', version: '1.0.0' } } });
});

it('returns a valid full task query when stored bodies exceed the input request-size limit', async () => {
  const h = await harness();
  const text = 'synthetic task content '.repeat(150);
  for (let i = 0; i < 100; i++) await h.store.create({ taskType: 'reminder', schedule: { kind: 'one-shot', fireAt: NOW + 3600000 }, timezone: 'UTC',
    startAt: NOW, nextFireAt: NOW + 3600000, createdBy: 'ou_synthetic', name: `Synthetic ${i}`, taskText: text, chatId: 'oc_synthetic' });
  const result = await h.call('automation.list');
  expect(result.category).toBe('ok'); expect(result.data.tasks).toHaveLength(100);
  expect(result.data.tasks[99].taskText).toBe(text);
}, 12000);

it('preserves UTF-8 when a real stdin writer splits a character between chunks', async () => {
  const h = await harness();
  let received: unknown;
  const proxy = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    received = JSON.parse(body).params.skill;
    // Forward the request to the actual bridge; no fixture tool result is injected.
    const actual = await fetch(h.run.env.LARK_BRIDGE_TOOL_ENDPOINT!, { method: 'POST', body, headers: { authorization: request.headers.authorization! } });
    response.end(await actual.text());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { proxy.closeAllConnections(); proxy.close(error => error ? reject(error) : resolve()); }));
  const skill = 'a中🙂b\n"\' $(synthetic)';
  const bytes = Buffer.from(JSON.stringify({ version: 1, operation: 'plugins.read', params: { skill } }));
  const split = bytes.indexOf(Buffer.from('中')) + 1;
  const result = await runToolProcess(join(client.directory, 'bin/lark-channel-bridge.mjs'), [bytes.subarray(0, split), bytes.subarray(split)], {
    ...h.run.env, LARK_BRIDGE_TOOL_ENDPOINT: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/tool`,
  }, [], client.directory);
  expect(result.code).toBe(0); expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({ category: 'unavailable', code: 'skill-not-found-or-ambiguous' });
  expect(received).toBe(skill);
});

it('advertises the same accepted schedule fields that preview validation enforces', async () => {
  const h = await harness();
  const schema = await h.call('automation.schema');
  const variants = schema.data.operations['automation.preview'].params.properties.schedule.oneOf;
  expect(variants.every((variant: { additionalProperties?: boolean }) => variant.additionalProperties === false)).toBe(true);
  expect(await h.call('automation.preview', { taskType: 'reminder', schedule: { kind: 'one-shot', fireAt: NOW + 3600000, unknown: true } }))
    .toMatchObject({ category: 'validation-failed', code: 'invalid-schedule' });
});

it.each(['2026-10-20T00:00:00Z', null, {}, false])('rejects an invalid supplied startAt (%j) without silently moving the requested start to today', async startAt => {
  const h = await harness();
  expect(await h.call('automation.preview', { taskType: 'reminder', schedule: {
    kind: 'daily', timezone: 'Asia/Shanghai', times: [{ hour: 9, minute: 0 }], startAt, endAt: Date.parse('2026-10-21T16:00:00Z'),
  } })).toMatchObject({ category: 'validation-failed', code: 'invalid-schedule', data: { fields: ['schedule.startAt'] } });
});

it.each([
  [{}, ['schedule.kind']],
  [{ kind: 'daily', timezone: 'UTC', startAt: NOW, endAt: NOW + 86400000, times: [{ hour: 9 }] }, ['schedule.times[0].minute']],
  [{ kind: 'interval', timezone: 'UTC', startAt: NOW, endAt: NOW + 86400000, every: { unit: 'hours' } }, ['schedule.every.n']],
])('identifies nested missing schedule fields in the same real tool loop', async (schedule, fields) => {
  const h = await harness();
  expect(await h.call('automation.preview', { taskType: 'reminder', schedule })).toMatchObject({ category: 'needs-input', data: { fields } });
});

it('rejects an overflowing interval rather than returning a successful null interval', async () => {
  const h = await harness();
  expect(await h.call('automation.preview', { taskType: 'reminder', schedule: {
    kind: 'interval', timezone: 'UTC', startAt: NOW, endAt: NOW + 86400000, every: { unit: 'hours', n: 1e308 },
  } })).toMatchObject({ category: 'validation-failed', code: 'invalid-schedule', data: { fields: ['schedule.every.n'] } });
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
}, MULTI_CLIENT_TIMEOUT_MS);

it('reports missing built-in content and absent or forged connections without granting other authority', async () => {
  const h = await harness({ catalog: await PluginCatalog.load(['/synthetic-missing-plugin']) });
  expect((await h.call('plugins.list')).data.diagnostics).toEqual([{ code: 'invalid-package' }]);
  expect(await h.call('automation.list')).toMatchObject({ category: 'unavailable', code: 'automation-plugin-unavailable' });
  expect(await h.call('plugins.install', { source: 'synthetic' })).toMatchObject({ category: 'unavailable', code: 'unknown-operation' });
  const absent = await client.call({ version: 1, operation: 'plugins.list' });
  expect(JSON.parse(absent.stdout)).toMatchObject({ category: 'unavailable', code: 'no-active-run' });
  expect(await h.call('plugins.list', {}, { ...h.run.env, LARK_BRIDGE_TOOL_TOKEN: 'synthetic-forged' })).toMatchObject({ category: 'unauthorized', code: 'invalid-run-credential' });
  const top = await client.call({ version: 1, operation: 'automation.list', profile: 'forged-profile' }, h.run.env);
  expect(JSON.parse(top.stdout)).toMatchObject({ category: 'validation-failed', code: 'unknown-field' });
}, MULTI_CLIENT_TIMEOUT_MS);
