import { isAbsolute } from 'node:path';

export const PROFILE_SCHEMA_VERSION = 3 as const;

export function upgradeProfileToCurrent(profile: unknown): { profile: unknown; changed: boolean } {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return { profile, changed: false };
  }
  const raw = profile as Record<string, unknown>;
  if (raw.schemaVersion === PROFILE_SCHEMA_VERSION) {
    return { profile, changed: false };
  }
  if (raw.schemaVersion === 1) {
    throw new Error('profile schemaVersion 1 cannot be upgraded here; run migrateV1ToV2');
  }
  if (raw.schemaVersion !== 2) {
    throw new Error(`unsupported profile schemaVersion ${String(raw.schemaVersion)}`);
  }
  return { profile: upgradeProfileV2ToV3(raw), changed: true };
}

export function upgradeProfileV2ToV3(raw: Record<string, unknown>): Record<string, unknown> {
  const existingAgent =
    raw.agent && typeof raw.agent === 'object' && !Array.isArray(raw.agent)
      ? (raw.agent as Record<string, unknown>)
      : {};
  const binaryPath = explicitBinaryPathFromV2(raw, existingAgent);
  return {
    ...raw,
    schemaVersion: PROFILE_SCHEMA_VERSION,
    agent: {
      kind: existingAgent.kind ?? raw.agentKind,
      ...(binaryPath ? { binaryPath } : {}),
    },
  };
}

export function upgradeRootProfiles(root: unknown): { root: unknown; changed: boolean } {
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return { root, changed: false };
  }
  const profiles = (root as { profiles?: unknown }).profiles;
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    return { root, changed: false };
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [name, profile] of Object.entries(profiles as Record<string, unknown>)) {
    const upgraded = upgradeProfileToCurrent(profile);
    next[name] = upgraded.profile;
    if (upgraded.changed) changed = true;
  }
  if (!changed) return { root, changed: false };
  return { root: { ...(root as Record<string, unknown>), profiles: next }, changed: true };
}

function explicitBinaryPathFromV2(
  raw: Record<string, unknown>,
  existingAgent: Record<string, unknown>,
): string | undefined {
  if (typeof existingAgent.binaryPath === 'string' && existingAgent.binaryPath.trim()) {
    return existingAgent.binaryPath.trim();
  }
  const codex =
    raw.codex && typeof raw.codex === 'object' && !Array.isArray(raw.codex)
      ? (raw.codex as Record<string, unknown>)
      : undefined;
  if (typeof codex?.binaryPath === 'string' && isAbsolute(codex.binaryPath)) {
    return codex.binaryPath;
  }
  return undefined;
}
