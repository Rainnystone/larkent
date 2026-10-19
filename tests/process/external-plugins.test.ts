import { execFile } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter';
import type { AgentEvent } from '../../src/agent/types';
import { buildToolProcess } from '../helpers/bridge-tool-process';
import { createTmpProfile } from '../helpers/tmp-profile';
import { writeExternalPlugin } from '../helpers/external-plugin';

let client: Awaited<ReturnType<typeof buildToolProcess>>;
const cleanup: Array<() => Promise<unknown>> = [];
beforeAll(async () => { client = await buildToolProcess(); });
afterAll(async () => { await client.cleanup(); });
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

it('uses the installed host and client outside the checkout and changes versions only after a host restart', async () => {
  const tmp = await createTmpProfile('external-process-'); cleanup.push(tmp.cleanup);
  const first = await writeExternalPlugin(join(tmp.root, 'v1'));
  const next = await writeExternalPlugin(join(tmp.root, 'v2'), '2.0.0', 7);
  const select = (root: string) => writeFile(join(tmp.root, 'plugins.json'), JSON.stringify({ schemaVersion: 1, packages: [root] }));
  await select(first);
  const host = await client.startHost(tmp.root); cleanup.push(host.close);
  const call = async (env: NodeJS.ProcessEnv, operation: string, params = {}) => {
    const result = await client.call({ version: 1, operation, params }, env);
    expect(result.code).toBe(0); expect(result.stderr).toBe('');
    return JSON.parse(result.stdout);
  };
  expect(await call(host.env, 'plugins.read', { skill: 'automation:automations' })).toMatchObject({ category: 'ok', data: { source: { plugin: 'automation' } } });
  const old = await call(host.env, 'plugins.read', { skill: 'compute' });
  expect(old).toMatchObject({ category: 'ok', data: { source: { version: '1.0.0' } } });
  await select(next);
  expect(await call(host.env, 'plugins.read', { skill: 'compute' })).toMatchObject({ category: 'ok', data: { source: { version: '1.0.0' } } });
  const restarted = await client.startHost(tmp.root); cleanup.push(restarted.close);
  expect(await call(restarted.env, 'plugins.read', { skill: 'compute', reference: old.data.source.reference })).toMatchObject({ category: 'unavailable', code: 'stale-plugin-reference' });
  const script = await call(restarted.env, 'plugins.read', { skill: 'compute', resource: 'skills/calculate/scripts/value.mjs' });
  expect(script).toMatchObject({ category: 'ok', data: { source: { version: '2.0.0' } } });
  const actual = await promisify(execFile)(process.execPath, [script.data.source.path], { cwd: client.directory });
  expect(JSON.parse(actual.stdout)).toEqual({ result: 7, doubled: 14 });
}, 30000);

it('carries catalog results through an actual adapter child and its ordinary script tool process in fresh and resumed runs', async () => {
  const tmp = await createTmpProfile('external-native-tool-'); cleanup.push(tmp.cleanup);
  const root = await writeExternalPlugin(join(tmp.root, 'fixture'));
  await writeFile(join(tmp.root, 'plugins.json'), JSON.stringify({ schemaVersion: 1, packages: [root] }));
  const host = await client.startHost(tmp.root); cleanup.push(host.close);
  const runtime = join(tmp.root, 'controlled-claude.mjs');
  await writeFile(runtime, `#!${process.execPath}\n${controlledRuntime}`);
  await chmod(runtime, 0o755);
  const adapter = new ClaudeAdapter({ binary: runtime });
  for (const resumeHandle of [undefined, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']) {
    const run = adapter.run({ runId: 'synthetic-script', prompt: 'Calculate the installed fixture value', cwd: tmp.workspace, toolEnv: host.env, resumeHandle });
    cleanup.push(() => run.stop());
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);
    expect(await run.waitForExit(5000)).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', output: expect.stringContaining('"result":42,"doubled":84'), isError: false }));
    expect(events.filter((event): event is Extract<AgentEvent, { type: 'text' }> => event.type === 'text').map(event => event.delta).join(''))
      .toBe(`runtime-script-result:42;resumed:${Boolean(resumeHandle)}`);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'error' }));
  }
}, 30000);

it('keeps built-in operations bound to their canonical package when an external alias collides', async () => {
  const tmp = await createTmpProfile('external-alias-'); cleanup.push(tmp.cleanup);
  const root = await writeExternalPlugin(join(tmp.root, 'fixture'));
  const manifestPath = join(root, '.codex-plugin/plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.larkent.aliases = ['automation'];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(tmp.root, 'plugins.json'), JSON.stringify({ schemaVersion: 1, packages: [root] }));
  const host = await client.startHost(tmp.root); cleanup.push(host.close);
  const child = await client.call({ version: 1, operation: 'automation.schema' }, host.env);
  expect(child.code).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({ category: 'unavailable', code: 'automation-store-unavailable' });
}, 20000);

it('publishes the exact plugin resource request fields in machine-readable schema', async () => {
  const result = await client.call('', {}, ['--schema']);
  expect(result.code).toBe(0);
  const schema = JSON.parse(result.stdout);
  expect(schema.$defs.pluginReadParams).toMatchObject({
    additionalProperties: false, required: ['skill'], properties: {
      skill: { type: 'string' }, resource: { type: 'string' }, reference: { type: 'string' },
    },
  });
});

// Controlled native-process protocol, not a paid model or a live CLI acceptance claim.
const controlledRuntime = String.raw`
import { execFileSync } from 'node:child_process';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const emit = row => console.log(JSON.stringify(row));
emit({ type: 'system', subtype: 'init', session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
const call = params => JSON.parse(execFileSync(process.execPath, [process.env.LARK_BRIDGE_TOOL_CLIENT, 'tool'], {
  input: JSON.stringify({ version: 1, operation: 'plugins.read', params }), encoding: 'utf8', env: process.env,
}));
const body = call({ skill: 'compute' });
if (body.category !== 'ok') throw new Error(JSON.stringify(body));
const script = call({ skill: 'compute', resource: 'skills/calculate/scripts/value.mjs', reference: body.data.source.reference });
if (script.category !== 'ok') throw new Error(JSON.stringify(script));
emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'script', name: 'Bash', input: { command: ['node', script.data.source.path] } }] } });
const actual = execFileSync(process.execPath, [script.data.source.path], { encoding: 'utf8', env: process.env });
emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'script', content: actual, is_error: false }] } });
const value = JSON.parse(actual).result;
emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'runtime-script-result:' + value + ';resumed:' + process.argv.includes('--resume') }] } });
emit({ type: 'result', subtype: 'success' });
`;
