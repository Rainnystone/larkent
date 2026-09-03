import { ClaudeAdapter } from '../agent/claude/adapter';
import { CodexAdapter } from '../agent/codex/adapter';
import { CursorAdapter } from '../agent/cursor/adapter';
import { GrokAdapter } from '../agent/grok/adapter';
import { KimiAdapter } from '../agent/kimi/adapter';
import type { LarkChannelEnvContext } from '../agent/lark-channel-env';
import { AgentPreflightError, type AgentAvailability, type LocalAgentId } from '../agent/preflight';
import {
  isAgentKind,
  unknownAgentKindMessage,
  type AgentKind,
} from '../agent/registry';
import type { AgentAdapter } from '../agent/types';
import type { AppPaths } from '../config/app-paths';
import type { ProfileConfig } from '../config/profile-schema';
import type { AcquiredRuntimeLock } from './locks';

type RuntimeAgentFactory = (
  profileConfig: ProfileConfig,
  appPaths: Pick<AppPaths, 'profileDir'>,
  larkChannel: LarkChannelEnvContext | undefined,
) => AgentAdapter;

const RUNTIME_AGENT_FACTORIES: Record<AgentKind, RuntimeAgentFactory> = {
  claude: (_profileConfig, _appPaths, larkChannel) => new ClaudeAdapter({ larkChannel }),
  codex: (profileConfig, appPaths, larkChannel) => {
    const codex = profileConfig.codex;
    if (!codex?.binaryPath) {
      throw new Error('codex profile requires codex.binaryPath');
    }
    return new CodexAdapter({
      binary: codex.binaryPath,
      profileStateDir: appPaths.profileDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      inheritCodexHome: codex.inheritCodexHome === true,
      ignoreUserConfig: codex.ignoreUserConfig === true,
      ignoreRules: codex.ignoreRules !== false,
      sandbox: profileConfig.sandbox.defaultMode,
      larkChannel,
    });
  },
  kimi: (_profileConfig, _appPaths, larkChannel) =>
    new KimiAdapter({
      binary: process.env.LARK_CHANNEL_KIMI_BIN ?? 'kimi',
      larkChannel,
    }),
  grok: (_profileConfig, _appPaths, larkChannel) =>
    new GrokAdapter({
      binary: process.env.LARK_CHANNEL_GROK_BIN ?? 'grok',
      larkChannel,
    }),
  cursor: (_profileConfig, _appPaths, larkChannel) =>
    new CursorAdapter({
      ...(process.env.LARK_CHANNEL_CURSOR_BIN
        ? { binary: process.env.LARK_CHANNEL_CURSOR_BIN }
        : {}),
      larkChannel,
    }),
};

/**
 * Build the agent adapter for a profile, wiring its per-profile lark-channel env
 * (so spawned agent processes see this profile's LARKSUITE_CLI_CONFIG_DIR etc.).
 * Shared by the foreground run path and the supervisor so both produce an
 * identically-configured adapter. Each profile MUST get its own adapter — the
 * adapter stores bot identity on itself (see `setBotIdentity`).
 */
export function createRuntimeAgent(
  profileConfig: ProfileConfig,
  appPaths: Pick<AppPaths, 'profileDir'> &
    Partial<Pick<AppPaths, 'rootDir' | 'profile' | 'configFile' | 'larkCliConfigDir' | 'larkCliSourceConfigFile'>> & {
      configPath?: string;
    },
): AgentAdapter {
  const larkChannelConfigPath = appPaths.configPath ?? appPaths.configFile;
  const larkChannel =
    appPaths.rootDir && appPaths.profile
      ? {
          profile: appPaths.profile,
          rootDir: appPaths.rootDir,
          ...(larkChannelConfigPath ? { configPath: larkChannelConfigPath } : {}),
          ...(appPaths.larkCliConfigDir ? { larkCliConfigDir: appPaths.larkCliConfigDir } : {}),
          ...(appPaths.larkCliSourceConfigFile
            ? { larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile }
            : {}),
        }
      : undefined;
  if (!isAgentKind(profileConfig.agentKind)) {
    throw new Error(unknownAgentKindMessage(profileConfig.agentKind));
  }
  return RUNTIME_AGENT_FACTORIES[profileConfig.agentKind](profileConfig, appPaths, larkChannel);
}

export async function checkRuntimeAgentAvailability(agent: AgentAdapter): Promise<AgentAvailability> {
  if (agent.checkAvailability) return agent.checkAvailability();
  const ok = await agent.isAvailable();
  if (ok) return { ok: true };
  if (!isAgentKind(agent.id)) {
    throw new Error(unknownAgentKindMessage(agent.id));
  }
  const agentId: LocalAgentId = agent.id;
  const diagnostic = {
    code: 'agent-binary-not-found' as const,
    agentId,
    agentName: agent.displayName,
    command: agentId,
  };
  return { ok: false, diagnostic, error: new AgentPreflightError(diagnostic) };
}

/** Guard: reconnect/restart must not switch a profile's agent kind mid-flight. */
export function assertReconnectAgentKindUnchanged(
  current: AgentKind | undefined,
  next: AgentKind | undefined,
): void {
  if (next !== current) {
    throw new Error(
      `agent kind cannot change during reconnect (${current ?? 'unset'} -> ${next ?? 'unset'}); stop/start is required`,
    );
  }
}

/** Release a set of runtime locks, swallowing individual failures. */
export async function releaseRuntimeLocks(locks: AcquiredRuntimeLock[]): Promise<void> {
  for (const lock of locks) {
    await lock.release().catch(() => undefined);
  }
}
