import { parseAntigravityAgentOptions } from '../agent/antigravity/options';
import { AgentPreflightError, type AgentAvailability } from '../agent/preflight';
import { descriptorFor, isAgentKind, type AgentKind } from '../agent/registry';
import type { AgentAdapter } from '../agent/types';
import type { AppPaths } from '../config/app-paths';
import type { ProfileConfig } from '../config/profile-schema';
import { getRunIdleTimeoutMs, isComplete } from '../config/schema';
import { logEffectiveAdapterTiming } from './effective-adapter-timing';
import type { AcquiredRuntimeLock } from './locks';
import { resolveProfileRuntime } from './profile-runtime';

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
  const descriptor = descriptorFor(profileConfig.agentKind);
  descriptor.agentOptionsSchema.parse(profileConfig.agent.options);
  const agent = descriptor.create({ profile: profileConfig, profileDir: appPaths.profileDir, larkChannel });
  const printTimeout = profileConfig.agentKind === 'antigravity'
    ? parseAntigravityAgentOptions(profileConfig.agent.options, true).printTimeout
    : undefined;
  logEffectiveAdapterTiming('created', {
    ...(appPaths.profile ? { profile: appPaths.profile } : {}),
    agentKind: profileConfig.agentKind,
    ...(larkChannelConfigPath ? { configPath: larkChannelConfigPath } : {}),
    printTimeout,
    printTimeoutSupported: profileConfig.agentKind === 'antigravity',
    idleTimeoutMs: getRunIdleTimeoutMs({ preferences: profileConfig.preferences }),
  });
  return agent;
}

export function resolveProfileBinary(profile: ProfileConfig): string | undefined {
  return descriptorFor(profile.agentKind).resolveProfileBinary(profile);
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

/** Load and parse on-disk config without swapping the live adapter or stopping runs. */
export async function assertReconnectConfig(input: {
  configPath: string;
  profile: string;
  currentAgentKind: AgentKind;
}): Promise<void> {
  const nextRuntime = await resolveProfileRuntime({
    config: input.configPath,
    profile: input.profile,
    allowBootstrap: false,
  });
  if (!isComplete(nextRuntime.cfg)) throw new Error('config incomplete after change');
  assertReconnectAgentKindUnchanged(input.currentAgentKind, nextRuntime.profileConfig.agentKind);
  descriptorFor(nextRuntime.profileConfig.agentKind)
    .agentOptionsSchema.parse(nextRuntime.profileConfig.agent.options);
}

/** Release a set of runtime locks, swallowing individual failures. */
export async function releaseRuntimeLocks(locks: AcquiredRuntimeLock[]): Promise<void> {
  for (const lock of locks) {
    await lock.release().catch(() => undefined);
  }
}
