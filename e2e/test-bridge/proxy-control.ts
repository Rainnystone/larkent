import { spawn } from 'node:child_process';
import { unlink, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { REPO_ROOT } from './paths';
import { PROXY_MODES, type FaultProxyMode } from './proxy';

const require = createRequire(import.meta.url);

export function tsxCliPath(): string {
  return require.resolve('tsx/cli');
}

export function faultProxySpawnArgv(stateDir: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [tsxCliPath(), join(REPO_ROOT, 'e2e', 'test-bridge', 'proxy-process.ts'), '--state-dir', stateDir],
  };
}

export interface ProxyStateFile {
  pid: number;
  url: string;
}

export interface ProxyModeFile {
  mode: FaultProxyMode;
  delayMs?: number;
  hosts?: string[];
}

export function proxyStatePath(stateDir: string): string {
  return join(stateDir, 'proxy.json');
}

export function proxyModePath(stateDir: string): string {
  return join(stateDir, 'proxy-mode.json');
}

export async function writeProxyMode(
  stateDir: string,
  mode: FaultProxyMode,
  extra?: { delayMs?: number; hosts?: string[] },
): Promise<void> {
  if (!(PROXY_MODES as readonly string[]).includes(mode)) {
    throw new Error(`unknown proxy mode: ${mode}`);
  }
  const body: ProxyModeFile = {
    mode,
    ...(extra?.delayMs !== undefined ? { delayMs: extra.delayMs } : {}),
    ...(extra?.hosts && extra.hosts.length > 0 ? { hosts: extra.hosts } : {}),
  };
  await writeFile(proxyModePath(stateDir), `${JSON.stringify(body)}\n`, { mode: 0o600 });
}

export async function readProxyMode(stateDir: string): Promise<ProxyModeFile> {
  try {
    const parsed = JSON.parse(await readFile(proxyModePath(stateDir), 'utf8')) as ProxyModeFile;
    if (!parsed || !(PROXY_MODES as readonly string[]).includes(parsed.mode)) {
      return { mode: 'off' };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { mode: 'off' };
    throw err;
  }
}

export async function readProxyState(stateDir: string): Promise<ProxyStateFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(proxyStatePath(stateDir), 'utf8')) as ProxyStateFile;
    if (!parsed || typeof parsed.pid !== 'number' || typeof parsed.url !== 'string') return undefined;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function startDetachedProxy(stateDir: string): Promise<ProxyStateFile> {
  await writeProxyMode(stateDir, 'off');
  const { command, args } = faultProxySpawnArgv(stateDir);
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  if (!child.pid) throw new Error('failed to spawn fault proxy');
  const state = await waitForProxyState(stateDir, 5_000);
  return state;
}

export async function stopDetachedProxy(stateDir: string): Promise<void> {
  const state = await readProxyState(stateDir);
  if (state) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  }
  try {
    await unlink(proxyStatePath(stateDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function waitForProxyState(stateDir: string, timeoutMs: number): Promise<ProxyStateFile> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readProxyState(stateDir);
    if (state) return state;
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error('fault proxy did not publish a listen URL');
}
