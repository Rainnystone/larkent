import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { redactDiagnosticText } from '../../core/logger';
import { isRecord, truncate } from '../final-answer/values';

export const STDOUT_CAPTURE_ENV = 'LARKENT_STDOUT_CAPTURE_DIR';
export const DEFAULT_CAPTURE_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_CAPTURE_MAX_FILES = 20;

const PAYLOAD_KEYS = new Set([
  'parameters',
  'arguments',
  'args',
  'rawinput',
  'rawoutput',
  'commandline',
  'prompt',
  'stdin',
  'input',
]);

const STRUCTURE_KEYS = new Set([
  'type', 'subtype', 'event', 'method', 'jsonrpc', 'kind', 'role', 'state', 'status', 'steptype',
  'sessionupdate', 'stopreason', 'finishedreason', 'terminalreason', 'errorcode', 'errortype',
  'toolname', 'name', 'model', 'canonicalmodel', 'version', 'cliversion', 'claudecodeversion',
  'permissionmode', 'apikeysource', 'provider', 'servicetier', 'cwd', 'hookevent', 'tasktype', 'outcome',
]);
const DIAGNOSTIC_TEXT_CHARS = 200;

export interface StdoutCapture {
  readonly path: string;
  noteLine(line: string): void;
  noteError(message: string): void;
  close(): void;
}

export interface OpenStdoutCaptureInput {
  dir: string;
  runId: string;
  spawnName: string;
  maxBytes?: number;
  maxFiles?: number;
  now?: () => number;
}

export function stdoutCaptureDirFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[STDOUT_CAPTURE_ENV];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function redactStdoutLine(line: string): unknown {
  try {
    return redactNode(JSON.parse(line) as unknown, undefined, undefined, []);
  } catch {
    return { text: diagnosticText(line) };
  }
}

export function openStdoutCapture(input: OpenStdoutCaptureInput): StdoutCapture {
  const maxBytes = input.maxBytes ?? DEFAULT_CAPTURE_MAX_BYTES;
  const maxFiles = input.maxFiles ?? DEFAULT_CAPTURE_MAX_FILES;
  mkdirSync(input.dir, { recursive: true, mode: 0o700 });
  chmodBestEffort(input.dir, 0o700);
  pruneCaptures(input.dir, maxFiles);
  const startedAt = input.now?.() ?? Date.now();
  const path = join(input.dir, captureFileName(input.spawnName, input.runId));
  const header = JSON.stringify({
    capture: 1,
    runId: input.runId,
    spawnName: input.spawnName,
    capturedAt: new Date(startedAt).toISOString(),
    maxBytes,
  });
  writeFileSync(path, `${header}\n`, { mode: 0o600 });
  chmodBestEffort(path, 0o600);

  let bytes = Buffer.byteLength(`${header}\n`, 'utf8');
  let stopped = false;
  let truncated = false;
  const truncationReserve = Buffer.byteLength(truncationLine(maxBytes));

  const writeRecord = (record: Record<string, unknown>): void => {
    if (stopped) return;
    const line = `${JSON.stringify(record)}\n`;
    const size = Buffer.byteLength(line, 'utf8');
    if (bytes + size + truncationReserve > maxBytes) {
      if (!truncated) {
        const trunc = truncationLine(bytes);
        if (bytes + Buffer.byteLength(trunc, 'utf8') <= maxBytes) {
          appendBestEffort(path, trunc);
          bytes += Buffer.byteLength(trunc, 'utf8');
        }
        truncated = true;
        stopped = true;
      }
      return;
    }
    appendBestEffort(path, line);
    bytes += size;
  };

  return {
    path,
    noteLine(line: string): void {
      writeRecord({
        t: (input.now?.() ?? Date.now()) - startedAt,
        line: redactStdoutLine(line),
      });
    },
    noteError(message: string): void {
      writeRecord({
        t: (input.now?.() ?? Date.now()) - startedAt,
        error: redactDiagnosticText(message),
      });
    },
    close(): void {
      stopped = true;
    },
  };
}

function truncationLine(bytes: number): string {
  return `${JSON.stringify({
    capture: 1,
    truncated: true,
    reason: 'max-bytes',
    bytes,
  })}\n`;
}

function captureFileName(spawnName: string, runId: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return `stdout-${safe(spawnName)}-${safe(runId)}.jsonl`;
}

function pruneCaptures(dir: string, maxFiles: number): void {
  if (maxFiles <= 0) return;
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return;
  }
  if (names.length < maxFiles) return;
  const ranked = names
    .map((name) => {
      const path = join(dir, name);
      try {
        return { path, mtime: statSync(path).mtimeMs };
      } catch {
        return { path, mtime: 0 };
      }
    })
    .sort((a, b) => a.mtime - b.mtime);
  const remove = ranked.length - (maxFiles - 1);
  for (const entry of ranked.slice(0, Math.max(0, remove))) {
    try {
      unlinkSync(entry.path);
    } catch {
      /* best-effort retention */
    }
  }
}

function redactNode(
  value: unknown,
  key: string | undefined,
  owner: Record<string, unknown> | undefined,
  ancestors: string[],
): unknown {
  if (typeof value === 'string') return redactString(value, key, owner, ancestors);
  if (Array.isArray(value)) return value.map((item) => redactNode(item, key, owner, ancestors));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [nestedKey, nested] of Object.entries(value)) {
    out[nestedKey] = shouldRedactKey(nestedKey, ancestors)
      ? '[REDACTED]'
      : redactNode(nested, nestedKey, value, [...ancestors, nestedKey]);
  }
  return out;
}

function redactString(
  value: string,
  key: string | undefined,
  owner: Record<string, unknown> | undefined,
  ancestors: string[],
): string {
  const name = key?.toLowerCase().replace(/[^a-z]/g, '');
  if (!name) return '[REDACTED]';
  if (STRUCTURE_KEYS.has(name) || name.endsWith('id')) return redactDiagnosticText(value);
  const errorText = name === 'error' || name === 'errormessage'
    || (name === 'message' && (owner?.type === 'error' || ancestors.at(-2)?.toLowerCase() === 'error'));
  return errorText ? diagnosticText(value) : '[REDACTED]';
}

function diagnosticText(value: string): string {
  return truncate(redactDiagnosticText(value), DIAGNOSTIC_TEXT_CHARS);
}

function shouldRedactKey(key: string, ancestors: string[]): boolean {
  const normalized = key.toLowerCase();
  if (PAYLOAD_KEYS.has(normalized)) return true;
  if (/token|secret|authorization|api[_-]?key|password|cookie|prompt/i.test(normalized)) {
    return true;
  }
  if (normalized === 'output' && ancestors.some((part) => /tool_info|item|tool_call|tool_result/i.test(part))) {
    return true;
  }
  if (normalized === 'content' && ancestors.some((part) => /tool_info|tool_call|tool_result|^tool$/i.test(part))) {
    return true;
  }
  if (normalized === 'command' && ancestors.some((part) => /item|parameters|tool_info|rawinput/i.test(part))) {
    return true;
  }
  return false;
}

function chmodBestEffort(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    if (!isIgnorableWindowsPermError(error)) throw error;
  }
}

function appendBestEffort(path: string, line: string): void {
  try {
    appendFileSync(path, line);
  } catch {
    /* capture must never break stdout drainage */
  }
}

function isIgnorableWindowsPermError(error: unknown): boolean {
  if (process.platform !== 'win32') return false;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES';
}
