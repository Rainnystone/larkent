import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'tsup';

/** Build the actual CLI entry, including its normal packaged resources, without a source cwd dependency. */
export async function buildToolProcess() {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-tool-cli-'));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'lark-channel-bridge', type: 'module' }));
  await cp(resolve('plugins'), join(directory, 'plugins'), { recursive: true });
  await symlink(resolve('node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await build({ entry: { cli: resolve('src/cli/index.ts') }, outDir: directory, format: ['esm'], platform: 'node', target: 'node20',
    bundle: true, splitting: false, dts: false, clean: false, silent: true, loader: { '.html': 'text' } });
  return {
    directory,
    async call(input: unknown, env: NodeJS.ProcessEnv = {}, args: string[] = []) {
      return runToolProcess(join(directory, 'cli.js'), typeof input === 'string' ? input : JSON.stringify(input), env, args, directory);
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
