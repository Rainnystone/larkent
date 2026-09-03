import { isAbsolute } from 'node:path';
import { isAgentKind, unknownAgentKindMessage, type AgentKind } from '../agent/registry';

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

export class UnsupportedProfileSchemaError extends Error {
  readonly schemaVersion: unknown;

  constructor(schemaVersion: unknown) {
    super(unsupportedSchemaMessage(schemaVersion));
    this.name = 'UnsupportedProfileSchemaError';
    this.schemaVersion = schemaVersion;
  }
}

export class UnsupportedProcessRegistrySchemaError extends Error {
  readonly schemaVersion: unknown;

  constructor(schemaVersion: unknown) {
    super(
      `unsupported process registry schemaVersion ${String(schemaVersion)}; expected ${PROCESS_REGISTRY_SCHEMA_VERSION}`,
    );
    this.name = 'UnsupportedProcessRegistrySchemaError';
    this.schemaVersion = schemaVersion;
  }
}

export function profileSchemaVersionOf(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return (raw as { schemaVersion?: unknown }).schemaVersion;
}

export function isLegacyProfileSchemaVersion(schemaVersion: unknown): boolean {
  return schemaVersion === undefined || schemaVersion === 1;
}

export function isKnownProfileSchemaVersion(schemaVersion: unknown): boolean {
  return schemaVersion === 2 || schemaVersion === PROFILE_SCHEMA_VERSION;
}

export function assertSupportedProfileSchemaVersion(schemaVersion: unknown): void {
  if (isLegacyProfileSchemaVersion(schemaVersion) || isKnownProfileSchemaVersion(schemaVersion)) {
    return;
  }
  throw new UnsupportedProfileSchemaError(schemaVersion);
}

export function assertSupportedProcessRegistrySchemaVersion(schemaVersion: unknown): void {
  if (schemaVersion === undefined || schemaVersion === PROCESS_REGISTRY_SCHEMA_VERSION) return;
  throw new UnsupportedProcessRegistrySchemaError(schemaVersion);
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
    throw new UnsupportedProfileSchemaError(root.schemaVersion);
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
    throw new UnsupportedProfileSchemaError(profile.schemaVersion);
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
    throw new Error(unknownAgentKindMessage(kind));
  }
  const agent: ProfileAgentV3 = {
    kind,
    ...(spreadBinaryPath(binaryPathFromV2(profile))),
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
      ...(spreadBinaryPath(optionalBinaryPath(profile.agent.binaryPath))),
    };
  }
  if (isAgentKind(profile.agentKind)) {
    return {
      kind: profile.agentKind,
      ...(spreadBinaryPath(binaryPathFromV2(profile))),
    };
  }
  throw new Error(unknownAgentKindMessage(profile.agentKind));
}

function binaryPathFromV2(profile: Record<string, unknown>): string | undefined {
  if (isRecord(profile.agent)) {
    const fromAgent = optionalBinaryPath(profile.agent.binaryPath);
    if (fromAgent) return fromAgent;
  }
  const kind = isRecord(profile.agent) && isAgentKind(profile.agent.kind)
    ? profile.agent.kind
    : profile.agentKind;
  if (kind !== 'codex') return undefined;
  const codex = isRecord(profile.codex) ? profile.codex : undefined;
  return absoluteBinaryPath(codex?.binaryPath);
}

function absoluteBinaryPath(value: unknown): string | undefined {
  return typeof value === 'string' && isAbsolute(value) ? value : undefined;
}

function optionalBinaryPath(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function spreadBinaryPath(binaryPath: string | undefined): { binaryPath: string } | Record<string, never> {
  return binaryPath ? { binaryPath } : {};
}

function unsupportedSchemaMessage(version: unknown): string {
  if (version === 1) {
    return 'profile schemaVersion 1 cannot be upgraded here; run migrateV1ToV2';
  }
  return `unsupported profile schemaVersion ${String(version)}; expected 2 or 3`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
