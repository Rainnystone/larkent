import { isAgentKind, type AgentKind } from '../agent/registry';

export interface SessionAgentHandle {
  resumeHandle: string;
  cwd: string;
}

export interface SessionEntry {
  resumeHandle?: string;
  cwd?: string;
  agentKind?: AgentKind;
  byAgent?: Partial<Record<AgentKind, SessionAgentHandle>>;
  updatedAt: number;
  /** 0 disables idle timeout; absence follows the global preference. */
  idleTimeoutMinutes?: number;
}

export interface SessionDocumentV2 {
  schemaVersion: 2;
  entries: Record<string, SessionEntry>;
}

const ENTRY_FIELDS = [
  'resumeHandle',
  'cwd',
  'updatedAt',
  'idleTimeoutMinutes',
  'agentKind',
  'byAgent',
] as const;

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
      const parsed = parseV2Entry(key, value);
      if (parsed) entries[key] = parsed;
    }
  }
  return { document: { schemaVersion: 2, entries }, upgraded };
}

function parseV2Entry(key: string, value: unknown): SessionEntry {
  if (!isObject(value) || Object.keys(value).some((field) => !ENTRY_FIELDS.includes(field as (typeof ENTRY_FIELDS)[number]))) {
    throw new Error(`Invalid session entry: ${key}`);
  }
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) {
    throw new Error(`Invalid session entry: ${key}`);
  }
  const hasHandle = Object.hasOwn(value, 'resumeHandle');
  const hasCwd = Object.hasOwn(value, 'cwd');
  const hasTimeout = Object.hasOwn(value, 'idleTimeoutMinutes');
  const byAgent = parseByAgent(value.byAgent);
  if (value.byAgent !== undefined && !byAgent) {
    throw new Error(`Invalid session entry: ${key}`);
  }
  const agentKind = parseAgentKind(value.agentKind);
  if (value.agentKind !== undefined && agentKind === undefined) {
    throw new Error(`Invalid session entry: ${key}`);
  }
  if (hasHandle !== hasCwd || (hasHandle && (typeof value.resumeHandle !== 'string' || typeof value.cwd !== 'string')) ||
      (hasTimeout && (typeof value.idleTimeoutMinutes !== 'number' || !Number.isInteger(value.idleTimeoutMinutes) || value.idleTimeoutMinutes < 0 || value.idleTimeoutMinutes > 120)) ||
      (!hasHandle && !hasTimeout && !byAgent)) {
    throw new Error(`Invalid session entry: ${key}`);
  }
  return {
    ...(hasHandle ? { resumeHandle: value.resumeHandle as string, cwd: value.cwd as string } : {}),
    ...(agentKind ? { agentKind } : {}),
    ...(byAgent ? { byAgent } : {}),
    updatedAt: value.updatedAt,
    ...(hasTimeout ? { idleTimeoutMinutes: value.idleTimeoutMinutes as number } : {}),
  };
}

function parseAgentKind(value: unknown): AgentKind | undefined {
  return isAgentKind(value) ? value : undefined;
}

function parseByAgent(raw: unknown): SessionEntry['byAgent'] | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) return undefined;
  const out: NonNullable<SessionEntry['byAgent']> = {};
  for (const [kind, value] of Object.entries(raw)) {
    if (!isAgentKind(kind) || !isObject(value)) return undefined;
    if (typeof value.resumeHandle !== 'string' || typeof value.cwd !== 'string') return undefined;
    if (Object.keys(value).some((field) => field !== 'resumeHandle' && field !== 'cwd')) return undefined;
    out[kind] = { resumeHandle: value.resumeHandle, cwd: value.cwd };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
