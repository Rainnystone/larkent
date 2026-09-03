import { ClaudeAdapter } from '../agent/claude/adapter';
import { CodexAdapter } from '../agent/codex/adapter';
import { CursorAdapter } from '../agent/cursor/adapter';
import { GrokAdapter } from '../agent/grok/adapter';
import { KimiAdapter } from '../agent/kimi/adapter';
import { AgentPreflightError, type AgentAvailability } from '../agent/preflight';
import { descriptorFor, isAgentKind, type AgentKind } from '../agent/registry';
import type { AgentAdapter } from '../agent/types';
import type { AppPaths } from '../config/app-paths';
import type { ProfileConfig } from '../config/profile-schema';
import type { AcquiredRuntimeLock } from './locks';

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
  const kind = profileConfig.agentKind;
  const descriptor = descriptorFor(kind);
  const envBinary = process.env[descriptor.envBinVar];
  const factories: Record<AgentKind, () => AgentAdapter> = {
    claude: () => new ClaudeAdapter({ larkChannel }),
    codex: () => {
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
    kimi: () =>
      new KimiAdapter({
        binary: envBinary ?? descriptor.binaryNames[0] ?? kind,
        larkChannel,
      }),
    grok: () =>
      new GrokAdapter({
        binary: envBinary ?? descriptor.binaryNames[0] ?? kind,
        larkChannel,
      }),
    cursor: () =>
      new CursorAdapter({
        ...(envBinary ? { binary: envBinary } : {}),
        larkChannel,
      }),
  };
  return factories[kind]();
}

export async function checkRuntimeAgentAvailability(agent: AgentAdapter): Promise<AgentAvailability> {
  if (agent.checkAvailability) return agent.checkAvailability();
  const ok = await agent.isAvailable();
  if (ok) return { ok: true };
  const agentId = isAgentKind(agent.id) ? agent.id : agent.id;
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
  if (current === next) return;
  throw new Error(
    `agent kind cannot change during reconnect (${current ?? 'none'} -> ${next ?? 'none'}); stop/start is required`,
  );
}

/** Release a set of runtime locks, swallowing individual failures. */
export async function releaseRuntimeLocks(locks: AcquiredRuntimeLock[]): Promise<void> {
  for (const lock of locks) {
    await lock.release().catch(() => undefined);
  }
}
