import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface IdentityPlan {
  args: string[];
  hold?: boolean;
  toolName?: string;
  toolInput?: unknown;
}

/** Controlled external CLIs: actual subprocesses, no Feishu or model traffic. */
export async function installProfileIdentityCli(root: string) {
  const directory = join(root, 'identity-cli');
  await mkdir(directory);
  const lark = join(directory, 'lark-cli.mjs');
  const agent = join(directory, 'claude.mjs');
  await writeFile(lark, larkSource);
  await writeFile(agent, `#!${process.execPath}\n${agentSource}`);
  await chmod(agent, 0o755);
  // Also catch any accidental invocation of the profile configuration helper.
  if (process.platform === 'win32') {
    await writeFile(join(directory, 'lark-cli.CMD'), `@echo off\r\n"${process.execPath}" "${lark}" %*\r\n`);
  } else {
    await writeFile(join(directory, 'lark-cli'), `#!${process.execPath}\n${larkSource}`, { mode: 0o755 });
  }
  return {
    agent, directory,
    async plan(id: string, plan: IdentityPlan) {
      await writeFile(join(directory, `${id}.json`), JSON.stringify(plan));
    },
  };
}

const agentSource = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const directory = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('0.0.0-controlled'); process.exit(0); }
const emit = row => console.log(JSON.stringify(row));
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const id = /identity-case:([a-z0-9-]+)/.exec(prompt)?.[1];
if (!id) throw new Error('missing controlled identity case');
const plan = JSON.parse(readFileSync(join(directory, id + '.json'), 'utf8'));
const systemPrompt = readFileSync(argv[argv.indexOf('--append-system-prompt-file') + 1], 'utf8');
appendFileSync(join(directory, 'runs.jsonl'), JSON.stringify({ id, systemPrompt, prompt, resumed: argv.includes('--resume'), hasToolConnection: Boolean(process.env.LARK_BRIDGE_TOOL_ENDPOINT && process.env.LARK_BRIDGE_TOOL_TOKEN) }) + '\n');
emit({ type: 'system', subtype: 'init', session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'identity-tool', name: plan.toolName ?? 'Bash', input: plan.toolInput ?? { command: ['lark-cli', ...plan.args] } }] } });
writeFileSync(join(directory, id + '.ready'), 'ready');
if (plan.hold) { while (!existsSync(join(directory, id + '.release'))) await delay(10); }
const result = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(directory, 'lark-cli.mjs'), ...plan.args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  child.on('error', reject);
  child.on('close', code => resolve({ code, stdout, stderr }));
});
emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'identity-tool', content: result.stdout || result.stderr, is_error: result.code !== 0 }] } });
if (result.code !== 0) {
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [result.stderr.trim()] });
  process.exitCode = 1;
} else {
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'identity-result:' + result.stdout.trim() }] } });
  emit({ type: 'result', subtype: 'success' });
}
`;

// This substitute owns a benign generation marker, lock and writeback. It proves
// environment/ownership across processes, not the installed lark-cli algorithm.
const larkSource = String.raw`
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const directory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const keys = ['LARK_CHANNEL', 'LARK_CHANNEL_HOME', 'LARK_CHANNEL_PROFILE', 'LARK_CHANNEL_CONFIG', 'LARKSUITE_CLI_CONFIG_DIR'];
const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
appendFileSync(join(directory, 'calls.jsonl'), JSON.stringify({ args, env }) + '\n');
const configDir = process.env.LARKSUITE_CLI_CONFIG_DIR;
const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
const identity = args.includes('user') || args.includes('--as=user') || args.includes('user-default') || args.includes('--identity=user-default') ? 'user' : 'bot';
if ((args[0] === 'config' && !['show', 'strict-mode', 'default-as', 'risk-control'].includes(args[1])) || (args[0] === 'config' && args.length > 2) || (args[0] === 'auth' && ['login', 'logout'].includes(args[1]))) {
  console.error('controlled configuration mutation attempted'); process.exit(7);
}
if (config.failure) { console.error(config.failure); process.exit(4); }
if (identity === 'user' && config.strictMode === 'bot') {
  console.error('profile strict-mode rejects user identity'); process.exit(4);
}
if (args[0] === 'auth') { console.log('authorized-profile-status'); process.exit(0); }
if (args[0] === 'config') { console.log('profile-config-status'); process.exit(0); }
if (identity === 'user') {
  const marker = join(configDir, 'credential-substitute.json');
  if (!existsSync(marker)) { console.error('profile authorization missing'); process.exit(4); }
  if (args.includes('--wait-for-peer')) {
    writeFileSync(join(configDir, 'peer-' + process.pid), 'ready');
    const deadline = Date.now() + 10000;
    const { readdirSync } = await import('node:fs');
    while (readdirSync(configDir).filter(name => name.startsWith('peer-')).length < 2) {
      if (Date.now() > deadline) throw new Error('concurrent CLI peer missing');
      await delay(10);
    }
  }
  const lock = join(configDir, 'refresh.lock');
  const deadline = Date.now() + 10000;
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (error) { if (error.code !== 'EEXIST' || Date.now() > deadline) throw error; await delay(10); }
  }
  try {
    const stored = JSON.parse(readFileSync(marker, 'utf8'));
    if (stored.expired) { console.error('profile authorization expired'); process.exitCode = 4; }
    else {
      if (stored.generation === 0) { await delay(40); stored.generation = 1; writeFileSync(marker, JSON.stringify(stored)); }
      console.log(JSON.stringify({ identity, subject: stored.subject, generation: stored.generation }));
    }
  } finally { rmSync(lock, { recursive: true }); }
} else { console.log(JSON.stringify({ identity })); }
`;
