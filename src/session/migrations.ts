export const CATALOG_SCHEMA_VERSION = 2;

export interface CatalogDocumentV2 {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION;
  entries: unknown[];
}

export interface MigrateCatalogResult {
  document: CatalogDocumentV2;
  dirty: boolean;
}

type CatalogRecord = Record<string, unknown>;

export function migrateCatalog(raw: unknown): MigrateCatalogResult {
  const arrayInput = Array.isArray(raw);
  const { version, entries } = inspectCatalog(raw);
  const foldLegacy = version < CATALOG_SCHEMA_VERSION || arrayInput;
  let dirty = foldLegacy;
  const next: unknown[] = [];
  for (const item of entries) {
    if (hasLegacyHandleFields(item)) dirty = true;
    const migrated = migrateCatalogEntry(item, foldLegacy || hasLegacyHandleFields(item));
    if (migrated) next.push(migrated);
  }
  return {
    document: {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      entries: next,
    },
    dirty,
  };
}

function inspectCatalog(raw: unknown): { version: number; entries: unknown[] } {
  if (Array.isArray(raw)) return { version: 1, entries: raw };
  if (!raw || typeof raw !== 'object') return { version: 1, entries: [] };
  const obj = raw as CatalogRecord;
  const version = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 1;
  const entries = Array.isArray(obj.entries) ? obj.entries : [];
  return { version, entries };
}

function migrateCatalogEntry(input: unknown, foldLegacy: boolean): CatalogRecord | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as CatalogRecord;
  if (
    typeof raw.key !== 'string' ||
    typeof raw.scopeId !== 'string' ||
    typeof raw.agentId !== 'string' ||
    typeof raw.cwdRealpath !== 'string' ||
    typeof raw.policyFingerprint !== 'string' ||
    (raw.status !== 'active' && raw.status !== 'archived') ||
    typeof raw.updatedAt !== 'number'
  ) {
    return undefined;
  }
  const resumeHandle =
    nonemptyString(raw.resumeHandle) ?? (foldLegacy ? foldV1ResumeHandle(raw) : undefined);
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

function hasLegacyHandleFields(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  return 'sessionId' in item || 'threadId' in item;
}

function foldV1ResumeHandle(raw: CatalogRecord): string | undefined {
  return nonemptyString(raw.threadId) ?? nonemptyString(raw.sessionId);
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
