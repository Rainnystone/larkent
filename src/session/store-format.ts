export interface SessionEntry {
  resumeHandle?: string;
  cwd?: string;
  updatedAt: number;
  /** 0 disables idle timeout; absence follows the global preference. */
  idleTimeoutMinutes?: number;
}

export interface SessionDocumentV2 {
  schemaVersion: 2;
  entries: Record<string, SessionEntry>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function upgradeSessionDocument(raw: unknown): { document: SessionDocumentV2; upgraded: boolean } {
  if (!isObject(raw)) throw new Error('Invalid session document: expected object');
  const upgraded = !Object.hasOwn(raw, 'schemaVersion');
  if (!upgraded && raw.schemaVersion !== 2) {
    throw new Error(`Unsupported session schemaVersion: ${String(raw.schemaVersion)}`);
  }
  if (!upgraded && Object.keys(raw).some(key => key !== 'schemaVersion' && key !== 'entries')) {
    throw new Error('Invalid session document fields');
  }
  const source = upgraded ? raw : raw.entries;
  if (!isObject(source)) throw new Error('Invalid session entries: expected object');
  const entries: Record<string, SessionEntry> = Object.create(null);
  for (const [key, value] of Object.entries(source)) {
    if (upgraded) {
      if (!isObject(value) || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) continue;
      const paired = typeof value.sessionId === 'string' && typeof value.cwd === 'string';
      const timeout = typeof value.idleTimeoutMinutes === 'number' && Number.isFinite(value.idleTimeoutMinutes)
        ? Math.min(Math.max(Math.floor(value.idleTimeoutMinutes), 0), 120) : undefined;
      if (!paired && timeout === undefined) continue;
      entries[key] = {
        ...(paired ? { resumeHandle: value.sessionId as string, cwd: value.cwd as string } : {}),
        updatedAt: value.updatedAt,
        ...(timeout !== undefined ? { idleTimeoutMinutes: timeout } : {}),
      };
    } else {
      if (!isObject(value) || Object.keys(value).some(field => !['resumeHandle', 'cwd', 'updatedAt', 'idleTimeoutMinutes'].includes(field)) ||
          typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) {
        throw new Error(`Invalid session entry: ${key}`);
      }
      const hasHandle = Object.hasOwn(value, 'resumeHandle');
      const hasCwd = Object.hasOwn(value, 'cwd');
      const hasTimeout = Object.hasOwn(value, 'idleTimeoutMinutes');
      if (hasHandle !== hasCwd || (hasHandle && (typeof value.resumeHandle !== 'string' || typeof value.cwd !== 'string')) ||
          (hasTimeout && (typeof value.idleTimeoutMinutes !== 'number' || !Number.isInteger(value.idleTimeoutMinutes) || value.idleTimeoutMinutes < 0 || value.idleTimeoutMinutes > 120)) ||
          (!hasHandle && !hasTimeout)) {
        throw new Error(`Invalid session entry: ${key}`);
      }
      entries[key] = { ...value } as unknown as SessionEntry;
    }
  }
  return { document: { schemaVersion: 2, entries }, upgraded };
}
