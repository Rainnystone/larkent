import { join } from 'node:path';

export interface LarkChannelEnvContext {
  profile?: string;
  rootDir?: string;
  configPath?: string;
  larkCliConfigDir?: string;
  larkCliSourceConfigFile?: string;
}

export function buildLarkChannelEnv(context?: LarkChannelEnvContext, toolEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LARK_CHANNEL: '1',
    // Protocol/tool stdout is plain text. Node warns when both are inherited.
    NO_COLOR: '1',
    FORCE_COLOR: undefined,
    // Remove any inherited connection when this run has none.
    LARK_BRIDGE_TOOL_ENDPOINT: toolEnv?.LARK_BRIDGE_TOOL_ENDPOINT,
    LARK_BRIDGE_TOOL_TOKEN: toolEnv?.LARK_BRIDGE_TOOL_TOKEN,
    LARK_BRIDGE_TOOL_CLIENT: toolEnv?.LARK_BRIDGE_TOOL_CLIENT,
    LARK_BRIDGE_TOOL_SCOPE: toolEnv?.LARK_BRIDGE_TOOL_SCOPE,
    LARK_BRIDGE_TOOL_ISSUED_AT: toolEnv?.LARK_BRIDGE_TOOL_ISSUED_AT,
  };
  const profile = nonEmpty(context?.profile);
  if (profile) env.LARK_CHANNEL_PROFILE = profile;

  const rootDir = nonEmpty(context?.rootDir);
  if (rootDir) env.LARK_CHANNEL_HOME = rootDir;

  const configPath =
    nonEmpty(context?.larkCliSourceConfigFile) ??
    nonEmpty(context?.configPath) ??
    (rootDir ? join(rootDir, 'config.json') : undefined);
  if (configPath) env.LARK_CHANNEL_CONFIG = configPath;

  const larkCliConfigDir = nonEmpty(context?.larkCliConfigDir);
  if (larkCliConfigDir) env.LARKSUITE_CLI_CONFIG_DIR = larkCliConfigDir;

  return env;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? value : undefined;
}
