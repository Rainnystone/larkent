import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jsonlScript, type PinAgentKind } from './scripted-jsonl-cli';

export interface ContractPlan {
  mode: 'create' | 'manage' | 'automatic' | 'delete' | 'read' | 'hold';
  now: number;
  operationId?: string;
  reference?: string;
}

/** Controlled runtime dialects, with actual client and script subprocesses. No model traffic. */
export async function installBridgeContractCli(root: string, kind: PinAgentKind) {
  const directory = join(root, `runtime ${kind} & fixture`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'runtime.mjs');
  const planPath = join(directory, 'plan.json');
  const reportPath = join(directory, 'report.json');
  const lines = jsonlScript(kind, 'success').lines;
  let turn = 0;
  await writeFile(path, `#!${process.execPath}\nconst kind = ${JSON.stringify(kind)};\nconst lines = ${JSON.stringify(lines)};\n${runtimeSource}`);
  await chmod(path, 0o755);
  return {
    path,
    async plan(plan: ContractPlan) {
      await rm(reportPath, { force: true });
      await writeFile(planPath, JSON.stringify({ ...plan, session: `00000000-0000-4000-8000-${String(++turn).padStart(12, '0')}` }));
    },
    async report(): Promise<any> { return JSON.parse(await readFile(reportPath, 'utf8')); },
  };
}

const runtimeSource = String.raw`
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('0.0.0-controlled'); process.exit(0); }
if (argv.includes('--help')) { console.log('Usage: runtime --output-format stream-json --approve-mcps'); process.exit(0); }
const directory = dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8'));
let stdin = '';
if (kind === 'claude' || kind === 'codex') for await (const chunk of process.stdin) stdin += chunk;
const prompt = stdin || (kind === 'cursor' ? argv.at(-1) : argv[argv.indexOf('-p') + 1]);
const envKeys = ['LARK_CHANNEL', 'LARK_CHANNEL_HOME', 'LARK_CHANNEL_PROFILE', 'LARK_CHANNEL_CONFIG', 'LARKSUITE_CLI_CONFIG_DIR', 'CODEX_HOME', 'LARK_BRIDGE_TOOL_CLIENT', 'LARK_BRIDGE_TOOL_SCOPE', 'LARK_BRIDGE_TOOL_ISSUED_AT'];
const report = { mode: plan.mode, session: plan.session, argv, prompt, cwd: process.cwd(), env: Object.fromEntries(envKeys.map(key => [key, process.env[key]])), connected: Boolean(process.env.LARK_BRIDGE_TOOL_TOKEN && process.env.LARK_BRIDGE_TOOL_ENDPOINT), calls: [] };
const call = (operation, params = {}) => {
  const child = spawnSync(process.execPath, [process.env.LARK_BRIDGE_TOOL_CLIENT, 'tool'], {
    input: JSON.stringify({ version: 1, operation, params }), encoding: 'utf8', env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (child.error || child.status !== 0 || child.stderr) throw new Error('client failed or mixed diagnostics with protocol');
  const stdout = child.stdout;
  if (stdout.trim().split('\n').length !== 1) throw new Error('tool stdout must contain one result');
  const result = JSON.parse(stdout);
  report.calls.push({ operation, result });
  return result;
};
call('plugins.list');
call('plugins.inspect', { plugin: 'automation' });
const body = call('plugins.read', { skill: 'compute' });
const script = call('plugins.read', { skill: 'compute', resource: 'skills/calculate/scripts/value.mjs', reference: body.data.source.reference });
report.script = JSON.parse(execFileSync(process.execPath, [script.data.source.path], { encoding: 'utf8', env: process.env }));
call('plugins.read', { skill: 'automation:automations' });
call('automation.schema');
const listed = call('automation.list');
call('plugins.list', { profile: 'forged', chatId: 'oc_other', actorId: 'ou_other', runType: 'im' });
if (plan.reference) call('plugins.read', { skill: 'compute', reference: plan.reference });
const correctedPreview = () => {
  const schedule = { kind: 'daily', timezone: 'Asia/Shanghai', times: [{ hour: 9, minute: 0 }], startAt: plan.now };
  const invalid = call('automation.preview', { taskType: 'agent', schedule });
  if (invalid.code !== 'missing-end-at') throw new Error('missing actionable correction feedback');
  // The next request is built from actual feedback, preserving 09:00 and adding only the missing boundary.
  schedule.endAt = plan.now + 3 * 86400000 - 8 * 3600000;
  call('automation.preview', { taskType: 'agent', schedule });
  return schedule;
};
if (plan.mode === 'create') {
  call('automation.create', null);
  const schedule = correctedPreview();
  const task = { taskType: 'agent', name: 'Synthetic & quoted task', taskText: 'literal "\'\n$(synthetic) ; & | <tag> 中🙂', schedule };
  const created = call('automation.create', task);
  if (created.category !== 'waiting-confirmation') throw new Error('creation did not reach confirmation');
  call('automation.create', { ...task, operationId: created.data.operationId });
  call('automation.operation.get', { operationId: created.data.operationId });
} else if (plan.mode === 'manage') {
  correctedPreview();
  call('automation.operation.get', { operationId: plan.operationId });
  const task = listed.data.tasks[0];
  const paused = call('automation.pause', { id: task.id, revision: task.revision });
  call('automation.operation.get', { operationId: paused.data.operationId });
  call('automation.resume', { id: task.id });
  call('automation.replace', { id: task.id, taskType: 'agent', name: 'Synthetic replacement', taskText: 'Read the script again', schedule: task.schedule });
} else if (plan.mode === 'automatic') {
  for (const operation of ['automation.preview', 'automation.create', 'automation.replace', 'automation.delete', 'automation.pause', 'automation.resume', 'automation.operation.get']) call(operation);
} else if (plan.mode === 'delete') {
  call('automation.operation.get', { operationId: plan.operationId });
  call('automation.delete', { id: listed.data.tasks[0].id });
}
// This record contains only synthetic observations. Credentials and endpoints never enter it.
writeFileSync(join(directory, 'report.json'), JSON.stringify(report));
console.error('controlled-runtime diagnostic');
if (plan.mode === 'hold') await new Promise(() => { setInterval(() => {}, 1000); });
const answer = 'contract-result:' + JSON.stringify({ mode: plan.mode, script: report.script, last: report.calls.at(-1).result.category });
for (const line of lines) console.log(JSON.stringify(line, (key, value) => key === 'cwd' ? undefined :
  ['session_id', 'thread_id', 'conversation_id', 'sessionId'].includes(key) ? plan.session : value === 'PINNED_ANSWER' ? answer : value));
`;
