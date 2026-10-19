import { fork, spawn } from 'node:child_process';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'tsup';

/** Build the actual CLI entry, including its normal packaged resources, without a source cwd dependency. */
export async function buildToolProcess() {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-tool-cli-'));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'lark-channel-bridge', type: 'module' }));
  await cp(resolve('plugins'), join(directory, 'plugins'), { recursive: true });
  await cp(resolve('bin'), join(directory, 'bin'), { recursive: true });
  await symlink(resolve('node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const hostEntry = join(directory, 'host.ts');
  await writeFile(hostEntry, `
    import { openToolRun } from ${JSON.stringify(resolve('src/bridge-tools/server.ts'))};
    import { builtinPluginCatalog } from ${JSON.stringify(resolve('src/plugins/catalog.ts'))};
    const run = await openToolRun({ catalog: await builtinPluginCatalog(), profile:'synthetic', chatId:'oc_synthetic', actorId:'ou_synthetic', runType:'im', availability:()=>undefined, timezone:'UTC', agentTasks:false });
    process.send(run.env);
    process.on('message', async () => { await run.close(); process.disconnect(); });
  `);
  await build({ entry: { cli: resolve('src/cli/index.ts'), host: hostEntry }, outDir: join(directory, 'dist'), format: ['esm'], platform: 'node', target: 'node20',
    bundle: true, splitting: false, dts: false, clean: false, silent: true, loader: { '.html': 'text' } });
  return {
    directory,
    async call(input: unknown, env: NodeJS.ProcessEnv = {}, args: string[] = []) {
      return runToolProcess(join(directory, 'bin/lark-channel-bridge.mjs'), typeof input === 'string' ? input : JSON.stringify(input), env, args, directory);
    },
    async startHost() {
      // Credential exchange stays on private IPC, separate from stdout/stderr and fixture files.
      const child = fork(join(directory, 'dist/host.js'), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], cwd: tmpdir() });
      const env = await new Promise<NodeJS.ProcessEnv>((resolve, reject) => {
        child.once('message', env => resolve(env as NodeJS.ProcessEnv));
        child.once('error', reject);
        child.once('exit', () => reject(new Error('tool host exited before ready')));
      });
      return { env, close: () => new Promise<void>((resolve, reject) => {
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('tool host failed')));
        child.send('close');
      }) };
    },
    cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
  };
}

export function runToolProcess(cli: string, input: string, env: NodeJS.ProcessEnv, args: string[] = [], cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cli, 'tool', ...args], { cwd, env: { ...process.env, LARK_BRIDGE_TOOL_ENDPOINT: '', LARK_BRIDGE_TOOL_TOKEN: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveResult({ code, stdout, stderr }));
    child.stdin.on('error', reject);
    child.stdin.end(input);
  });
}
