import { mergeProcessEnv } from '../platform/spawn';

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
