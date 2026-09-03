import { isAgentKind, type AgentKind } from '../agent/registry';

export const CATALOG_SCHEMA_VERSION = 2;

export interface CatalogFileV2 {
  schemaVersion: 2;
  entries: CatalogEntryV2[];
}

export interface CatalogEntryV2 {
  key: string;
  scopeId: string;
  agentId: AgentKind;
  cwdRealpath: string;
  policyFingerprint: string;
  status: 'active' | 'archived';
  updatedAt: number;
  resumeHandle: string;
  lastSummary?: string;
}

export interface CatalogUpgradeResult {
  document: CatalogFileV2;
  upgraded: boolean;
}

export class UnsupportedCatalogSchemaError extends Error {
  readonly schemaVersion: unknown;

  constructor(schemaVersion: unknown) {
    const detail =
      schemaVersion === undefined
        ? 'expected a v1 array or schemaVersion 2'
        : `unsupported catalog schemaVersion: ${String(schemaVersion)}`;
    super(detail);
    this.name = 'UnsupportedCatalogSchemaError';
    this.schemaVersion = schemaVersion;
  }
}

export function upgradeCatalogDocument(raw: unknown): CatalogUpgradeResult {
  if (isCatalogFileV2(raw)) {
    const entries: CatalogEntryV2[] = [];
    for (const item of raw.entries) {
      const entry = upgradeCatalogEntry(item);
      if (entry) entries.push(entry);
    }
    return { document: { schemaVersion: CATALOG_SCHEMA_VERSION, entries }, upgraded: false };
  }
  if (Array.isArray(raw)) {
    const upgradedEntries: CatalogEntryV2[] = [];
    for (const item of raw) {
      const entry = upgradeCatalogEntry(item);
      if (entry) upgradedEntries.push(entry);
    }
    return {
      document: { schemaVersion: CATALOG_SCHEMA_VERSION, entries: upgradedEntries },
      upgraded: true,
    };
  }
  const schemaVersion =
    raw && typeof raw === 'object'
      ? (raw as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  throw new UnsupportedCatalogSchemaError(schemaVersion);
}

function isCatalogFileV2(raw: unknown): raw is { schemaVersion: 2; entries: unknown[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const doc = raw as { schemaVersion?: unknown; entries?: unknown };
  return doc.schemaVersion === CATALOG_SCHEMA_VERSION && Array.isArray(doc.entries);
}

function upgradeCatalogEntry(input: unknown): CatalogEntryV2 | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as {
    key?: unknown;
    scopeId?: unknown;
    agentId?: unknown;
    cwdRealpath?: unknown;
    policyFingerprint?: unknown;
    status?: unknown;
    updatedAt?: unknown;
    resumeHandle?: unknown;
    sessionId?: unknown;
    threadId?: unknown;
    lastSummary?: unknown;
  };
  if (
    typeof raw.key !== 'string' ||
    typeof raw.scopeId !== 'string' ||
    !isAgentKind(raw.agentId) ||
    typeof raw.cwdRealpath !== 'string' ||
    typeof raw.policyFingerprint !== 'string' ||
    (raw.status !== 'active' && raw.status !== 'archived') ||
    typeof raw.updatedAt !== 'number'
  ) {
    return undefined;
  }
  const resumeHandle =
    typeof raw.resumeHandle === 'string'
      ? raw.resumeHandle
      : typeof raw.threadId === 'string'
        ? raw.threadId
        : typeof raw.sessionId === 'string'
          ? raw.sessionId
          : undefined;
  if (!resumeHandle) return undefined;
  return {
    key: raw.key,
    scopeId: raw.scopeId,
    agentId: raw.agentId,
    cwdRealpath: raw.cwdRealpath,
    policyFingerprint: raw.policyFingerprint,
    status: raw.status,
    updatedAt: raw.updatedAt,
    resumeHandle,
    ...(typeof raw.lastSummary === 'string' ? { lastSummary: raw.lastSummary } : {}),
  };
}
