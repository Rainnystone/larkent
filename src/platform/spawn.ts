import { existsSync } from 'node:fs';
import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
  type SpawnSyncOptions,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import crossSpawn from 'cross-spawn';

/**
 * Turn journal reaps agent CLI orphans. The JSONL runner passes
 * `detached: true` so a supervise.sh / Ctrl-C group signal does not kill an
 * in-flight CLI, and a SIGKILL of the bridge leaves a child the journal can
 * match by pid + start time. Other `spawnProcess` callers keep the default
 * (same group) unless they opt in.
 */
export function spawnProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  const direct = windowsDirectNodeSpawn(command, args, options.shell);
  if (direct) return nodeSpawn(direct.command, direct.args, options);
  return crossSpawn(command, [...args], options);
}

export function spawnProcessSync(
  command: string,
  args: readonly string[] = [],
  options: SpawnSyncOptions = {},
) {
  const direct = windowsDirectNodeSpawn(command, args, options.shell);
  if (direct) return nodeSpawnSync(direct.command, direct.args, options);
  return crossSpawn.sync(command, [...args], options);
}

function windowsDirectNodeSpawn(
  command: string,
  args: readonly string[],
  shell: boolean | string | undefined,
): { command: string; args: string[] } | undefined {
  if (missingWindowsPathSkipsCmdWrap(command, shell)) {
    return { command, args: [...args] };
  }
  return windowsExistingMjsUsesNode(command, args, shell);
}

/**
 * cross-spawn on Windows wraps anything that is not `*.exe`/`*.com` with
 * `cmd.exe /d /s /c` — including a path that does not exist
 * (`needsShell = !/\.(?:com|exe)$/i.test(undefined)`). That assigns a pid
 * and can exit 0 before "not recognized" stderr is classified, so a missing
 * JSONL CLI looks like a clean empty success. Spawn the missing path with
 * Node instead so it surfaces ENOENT.
 */
function missingWindowsPathSkipsCmdWrap(command: string, shell: boolean | string | undefined): boolean {
  if (process.platform !== 'win32' || shell) return false;
  if (!/[\\/]/.test(command) || /\.(?:exe|com|cmd|bat)$/i.test(command)) return false;
  try {
    return !existsSync(command);
  } catch {
    return false;
  }
}

/**
 * cross-spawn still cmd-wraps an *existing* `.mjs` file (not `.exe`).
 * That wrap plus Codex argv (`-c approval_policy="never"`, `-C` cwd with `&`)
 * can swallow stdin so a controlled runtime never reaches `report.json`.
 * Invoke the current Node on the script instead.
 */
function windowsExistingMjsUsesNode(
  command: string,
  args: readonly string[],
  shell: boolean | string | undefined,
): { command: string; args: string[] } | undefined {
  if (process.platform !== 'win32' || shell) return undefined;
  if (!/\.mjs$/i.test(command)) return undefined;
  try {
    if (!existsSync(command)) return undefined;
  } catch {
    return undefined;
  }
  return { command: process.execPath, args: [command, ...args] };
}

export function mergeProcessEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(out)) {
      if (existing.toLowerCase() === key.toLowerCase()) {
        delete out[existing];
      }
    }
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Names copied from the bridge process into an agent CLI.
 * Everything else is dropped. Secret-shaped names are dropped even if they
 * would otherwise match, except the CLI auth names listed below.
 *
 * `SSH_AUTH_SOCK` matches `*AUTH*` but is a socket path the CLI needs for
 * git, not a credential value, so it stays.
 */
const PASSTHROUGH = new Set([
  'path',
  'home',
  'user',
  'logname',
  'shell',
  'lang',
  'language',
  'term',
  'tz',
  'tmpdir',
  'tmp',
  'temp',
  'xdg_config_home',
  'xdg_data_home',
  'xdg_cache_home',
  'xdg_state_home',
  'xdg_runtime_dir',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'ssl_cert_file',
  'ssl_cert_dir',
  'requests_ca_bundle',
  'curl_ca_bundle',
  'node_extra_ca_certs',
  'node_path',
  'ssh_auth_sock',
  'systemroot',
  'systemdrive',
  'windir',
  'comspec',
  'pathext',
  'appdata',
  'localappdata',
  'userprofile',
  'homedrive',
  'homepath',
  'programfiles',
  'programdata',
  'claude_config_dir',
  'codex_home',
  // The CLI's own credentials. Bridge secrets are not in this list.
  'xai_api_key',
  'grok_api_key',
  'anthropic_api_key',
  'anthropic_auth_token',
  'claude_code_oauth_token',
  'openai_api_key',
  'openai_base_url',
  'cursor_api_key',
  'moonshot_api_key',
  'kimi_api_key',
  'gemini_api_key',
  'google_api_key',
  'aws_access_key_id',
  'aws_secret_access_key',
  'aws_session_token',
  'aws_profile',
  'aws_region',
  'aws_default_region',
]);

const SECRET_NAME = /key|token|secret|password|auth|webhook/i;

/** Environment passed to an agent CLI. Explicit overrides (tool env, channel) win. */
export function agentSpawnEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!mayInherit(key)) continue;
    inherited[key] = value;
  }
  return mergeProcessEnv(inherited, overrides);
}

function mayInherit(key: string): boolean {
  const lower = key.toLowerCase();
  if (PASSTHROUGH.has(lower)) return true;
  if (SECRET_NAME.test(key)) return false;
  return lower.startsWith('lc_');
}

export type SpawnedProcessByStdio<
  Stdin extends Writable | null,
  Stdout extends Readable | null,
  Stderr extends Readable | null,
> = ChildProcessByStdio<Stdin, Stdout, Stderr>;
