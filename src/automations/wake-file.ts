import { randomBytes } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFireKey } from './schedule';
import { writeFileAtomic } from '../platform/atomic-write';

export const WAKE_REQUEST_VERSION = 1 as const;
export const WAKE_WATCH_FALLBACK_MS = 500;

export interface WakeWatch {
  close(): void;
}

interface WakeRequestFile {
  v: typeof WAKE_REQUEST_VERSION;
  fireKey: string;
}

export async function enqueueWakeRequest(dir: string, fireKey: string): Promise<void> {
  if (!parseFireKey(fireKey)) throw new Error(`invalid fire key: ${fireKey}`);
  await mkdir(dir, { recursive: true });
  const name = `wake-${Date.now()}-${randomBytes(4).toString('hex')}.json`;
  const body: WakeRequestFile = { v: WAKE_REQUEST_VERSION, fireKey };
  await writeFileAtomic(join(dir, name), `${JSON.stringify(body)}\n`, { mode: 0o600 });
}

export async function consumeWakeRequests(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (!isWakeRequestName(name)) continue;
    const path = join(dir, name);
    let fireKey: string | undefined;
    try {
      fireKey = parseWakeRequest(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!fireKey || seen.has(fireKey)) continue;
    seen.add(fireKey);
    keys.push(fireKey);
  }
  return keys;
}

export function watchWakeDir(dir: string, onKeys: (keys: string[]) => void): WakeWatch {
  let closed = false;
  let watcher: FSWatcher | undefined;
  let draining = false;
  let queued = false;

  const drain = async (): Promise<void> => {
    if (closed) return;
    if (draining) {
      queued = true;
      return;
    }
    draining = true;
    try {
      do {
        queued = false;
        const keys = await consumeWakeRequests(dir);
        if (!closed && keys.length > 0) onKeys(keys);
      } while (queued && !closed);
    } finally {
      draining = false;
    }
  };

  const interval = setInterval(() => {
    void drain();
  }, WAKE_WATCH_FALLBACK_MS);
  interval.unref();

  void mkdir(dir, { recursive: true }).then(() => {
    if (closed) return;
    watcher = watch(dir, { persistent: false }, () => {
      void drain();
    });
    watcher.on('error', () => {});
  });

  return {
    close(): void {
      closed = true;
      clearInterval(interval);
      watcher?.close();
      watcher = undefined;
    },
  };
}

function isWakeRequestName(name: string): boolean {
  if (name.startsWith('.')) return false;
  return name.endsWith('.json');
}

function parseWakeRequest(text: string): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (rec.v !== WAKE_REQUEST_VERSION || typeof rec.fireKey !== 'string') return undefined;
  return parseFireKey(rec.fireKey) ? rec.fireKey : undefined;
}
