import { isAgentKind, type AgentKind } from '../agent/registry';

export const PROFILE_SCHEMA_VERSION = 3;
export const PROCESS_REGISTRY_SCHEMA_VERSION = 1;
export const RUNTIME_LOCK_SCHEMA_VERSION = 1;

export interface ProfileAgentV3 {
  kind: AgentKind;
  binaryPath?: string;
}

export interface ProfileUpgradeResult<T> {
  document: T;
  upgraded: boolean;
}

export function upgradeRootConfigDocument(raw: unknown): ProfileUpgradeResult<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('root config must be an object');
  }
  const root = raw as Record<string, unknown>;
  if (root.schemaVersion === PROFILE_SCHEMA_VERSION) {
    const profiles = upgradeProfilesMap(root.profiles, false);
    return {
      document: { ...root, schemaVersion: PROFILE_SCHEMA_VERSION, profiles: profiles.profiles },
      upgraded: profiles.upgraded,
    };
  }
  if (root.schemaVersion !== 2) {
    throw new Error('profile schemaVersion must be 2 or 3');
  }
  const profiles = upgradeProfilesMap(root.profiles, true);
  return {
    document: { ...root, schemaVersion: PROFILE_SCHEMA_VERSION, profiles: profiles.profiles },
    upgraded: true,
  };
}

export function upgradeProfileRecord(raw: unknown): ProfileUpgradeResult<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('profile config must be an object');
  }
  const profile = raw as Record<string, unknown>;
  if (profile.schemaVersion === PROFILE_SCHEMA_VERSION) {
    const agent = currentAgent(profile);
    return {
      document: {
        ...profile,
        schemaVersion: PROFILE_SCHEMA_VERSION,
        agent,
        agentKind: agent.kind,
      },
      upgraded: false,
    };
  }
  if (profile.schemaVersion !== 2) {
    throw new Error('profile schemaVersion must be 2 or 3');
  }
  return {
    document: upgradeProfileV2(profile),
    upgraded: true,
  };
}

function upgradeProfilesMap(
  raw: unknown,
  force: boolean,
): { profiles: Record<string, Record<string, unknown>>; upgraded: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('root config profiles must be an object');
  }
  const profiles: Record<string, Record<string, unknown>> = {};
  let upgraded = force;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const result = upgradeProfileRecord(value);
    profiles[name] = result.document;
    if (result.upgraded) upgraded = true;
  }
  return { profiles, upgraded };
}

function upgradeProfileV2(profile: Record<string, unknown>): Record<string, unknown> {
  const kind = profile.agentKind;
  if (!isAgentKind(kind)) {
    throw new Error(`unsupported agent: ${String(kind)}`);
  }
  const codex = isRecord(profile.codex) ? profile.codex : undefined;
  const binaryPath = typeof codex?.binaryPath === 'string' ? codex.binaryPath : undefined;
  const agent: ProfileAgentV3 = {
    kind,
    ...(binaryPath ? { binaryPath } : {}),
  };
  return {
    ...profile,
    schemaVersion: PROFILE_SCHEMA_VERSION,
    agent,
    agentKind: kind,
  };
}

function currentAgent(profile: Record<string, unknown>): ProfileAgentV3 {
  if (isRecord(profile.agent) && isAgentKind(profile.agent.kind)) {
    return {
      kind: profile.agent.kind,
      ...(typeof profile.agent.binaryPath === 'string' ? { binaryPath: profile.agent.binaryPath } : {}),
    };
  }
  if (isAgentKind(profile.agentKind)) {
    const codex = isRecord(profile.codex) ? profile.codex : undefined;
    const binaryPath = typeof codex?.binaryPath === 'string' ? codex.binaryPath : undefined;
    return {
      kind: profile.agentKind,
      ...(binaryPath ? { binaryPath } : {}),
    };
  }
  throw new Error(`unsupported agent: ${String(profile.agentKind)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
