import { execFileSync, spawn } from 'node:child_process';
import { access, chmod, mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDefaultProfileConfig } from '../../src/config/profile-schema';
import { createRootConfig, saveRootConfig, writeActiveProfile } from '../../src/config/profile-store';
import type { TestBridgeConfig } from './config';
import { faultDirPath, FAKE_CLI, pidFilePath, REPO_ROOT, SHIM_ENTRY } from './paths';
import {
  assertTestInstanceCmdline,
  readPidFile,
  readProcessCmdline,
  writePidFile,
  PidFileError,
} from './pidfile';
import {
  readProxyState,
  startDetachedProxy,
  stopDetachedProxy,
  writeProxyMode,
} from './proxy-control';
import type { FaultProxyMode } from './proxy';
import { armFault, clearFaults } from './fault-state';

export interface UpOptions {
  config: TestBridgeConfig;
  realCli?: boolean;
  realCliPath?: string;
  /** When true, regenerate config.json. Otherwise keep an existing file. */
  resetConfig?: boolean;
}

export async function shouldRewriteTestBridgeConfig(
  configPath: string,
  resetConfig = false,
): Promise<boolean> {
  if (resetConfig) return true;
  try {
    await access(configPath);
    return false;
  } catch {
    return true;
  }
}

export interface RunningBridge {
  pid: number;
  rootDir: string;
  proxyUrl: string;
}

export async function up(opts: UpOptions): Promise<RunningBridge> {
  assertPosix();
  const { config } = opts;
  await mkdir(config.dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(config.testerConfigDir, { recursive: true, mode: 0o700 });
  const workspace = join(`${config.dataRoot}-workspaces`, config.profile, 'default');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await chmod(SHIM_ENTRY, 0o755);

  const target = opts.realCli
    ? opts.realCliPath ?? process.env.LARK_CHANNEL_CURSOR_BIN ?? 'cursor-agent'
    : FAKE_CLI;
  const faultDir = faultDirPath(config.dataRoot);
  await mkdir(faultDir, { recursive: true });
  await clearFaults(faultDir);

  const proxy = await startDetachedProxy(config.dataRoot);

  const secretFile = join(config.dataRoot, 'app-secret');
  await writeFile(secretFile, config.appSecret, { mode: 0o600 });

  const configPath = join(config.dataRoot, 'config.json');
  if (await shouldRewriteTestBridgeConfig(configPath, opts.resetConfig === true)) {
    const profile = createDefaultProfileConfig({
      agentKind: config.agentKind,
      binaryPath: SHIM_ENTRY,
      accounts: {
        app: {
          id: config.appId,
          secret: { source: 'file', id: secretFile },
          tenant: config.tenant,
        },
      },
      access: {
        allowedUsers: config.allowedUsers,
        allowedChats: config.allowedChats,
        fence: { enabled: true },
      },
    });
    profile.instance = 'test';
    profile.workspaces = { ...profile.workspaces, default: workspace };
    await saveRootConfig(createRootConfig(config.profile, profile), configPath);
  }
  await writeActiveProfile(config.dataRoot, config.profile);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LARKENT_INSTANCE: 'test',
    LARK_CHANNEL_HOME: config.dataRoot,
    HTTPS_PROXY: proxy.url,
    LARKENT_E2E_FAULT_DIR: faultDir,
    LARKENT_E2E_SHIM_TARGET: target,
    LARKENT_E2E_REPO_ROOT: REPO_ROOT,
    LARKENT_E2E_TSX: join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
  };
  const log = await open(join(config.dataRoot, 'test-bridge.stdout.log'), 'a');
  const child = spawn(
    process.execPath,
    [
      join(REPO_ROOT, 'bin', 'lark-channel-bridge.mjs'),
      'run',
      '-c',
      configPath,
      '--profile',
      config.profile,
      '--skip-check-lark-cli',
    ],
    {
      env,
      stdio: ['ignore', log.fd, log.fd],
      detached: true,
    },
  );
  child.unref();
  await log.close();
  if (!child.pid) throw new Error('failed to spawn test bridge');

  const cmdline = `${process.execPath} ${join(REPO_ROOT, 'bin', 'lark-channel-bridge.mjs')} run -c ${configPath}`;
  await writePidFile(pidFilePath(config.dataRoot), {
    pid: child.pid,
    instance: config.instance,
    rootDir: config.dataRoot,
    cmdline,
    proxyPid: proxy.pid,
    startedAt: new Date().toISOString(),
  });
  return { pid: child.pid, rootDir: config.dataRoot, proxyUrl: proxy.url };
}

export async function down(dataRoot: string): Promise<void> {
  assertPosix();
  const file = await readPidFile(pidFilePath(dataRoot));
  let cmdline: string;
  try {
    cmdline = readProcessCmdline(file.pid);
  } catch (err) {
    if (err instanceof PidFileError) {
      await stopDetachedProxy(dataRoot);
      return;
    }
    throw err;
  }
  assertTestInstanceCmdline(cmdline, file.rootDir);
  await signalPid(file.pid, 'SIGTERM');
  const exited = await waitForPidExit(file.pid, 8_000);
  if (!exited) await signalPid(file.pid, 'SIGKILL');
  await stopDetachedProxy(dataRoot);
}

export async function armDriverFault(
  dataRoot: string,
  mode: string,
  opts: { runId?: string; sticky?: boolean } = {},
): Promise<void> {
  await armFault(faultDirPath(dataRoot), { mode, ...opts });
}

export async function setProxyMode(
  dataRoot: string,
  mode: FaultProxyMode,
  extra?: { delayMs?: number; hosts?: string[] },
): Promise<void> {
  const state = await readProxyState(dataRoot);
  if (!state) throw new Error('fault proxy is not running; start with e2e:up first');
  await writeProxyMode(dataRoot, mode, extra);
  await new Promise((resolve) => {
    setTimeout(resolve, 150);
  });
}

export async function killCli(
  dataRoot: string,
  variant: 'child-only' | 'process-group',
): Promise<void> {
  assertPosix();
  const file = await readPidFile(pidFilePath(dataRoot));
  const children = listChildPids(file.pid);
  if (variant === 'process-group') {
    try {
      process.kill(-file.pid, 'SIGTERM');
    } catch {
      await signalPid(file.pid, 'SIGTERM');
    }
    return;
  }
  for (const pid of children) {
    await signalPid(pid, 'SIGTERM');
  }
}

export async function freezeBridge(dataRoot: string, frozen: boolean): Promise<void> {
  assertPosix();
  const file = await readPidFile(pidFilePath(dataRoot));
  await signalPid(file.pid, frozen ? 'SIGSTOP' : 'SIGCONT');
}

function assertPosix(): void {
  if (process.platform === 'win32') {
    throw new Error('test-bridge driver is POSIX-only');
  }
}

async function signalPid(pid: number, signal: NodeJS.Signals): Promise<void> {
  try {
    process.kill(pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = (): void => {
      try {
        process.kill(pid, 0);
        if (Date.now() - started >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tick, 50);
      } catch {
        resolve(true);
      }
    };
    tick();
  });
}

function listChildPids(parent: number): number[] {
  try {
    const out = execFileSync('pgrep', ['-P', String(parent)], { encoding: 'utf8' });
    return out
      .split(/\s+/)
      .map((item) => Number(item))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}
