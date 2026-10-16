import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename as fsRename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as nativeSetTimeout } from 'node:timers';

export interface AtomicWriteOptions {
  mode?: number;
  maxRenameAttempts?: number;
  retryDelayMs?: number;
  rename?: (
    from: string,
    to: string,
    fallbackRename: (from: string, to: string) => Promise<void>,
  ) => Promise<void>;
}

// graceful-fs.rename retries EPERM/EBUSY/EACCES for up to 60s on Windows when
// the destination is missing (AV locking the directory). Session store and
// journal startup writes hit that path, so tests die at 5s with no EPERM in
// the log. Bound the retry ourselves instead.
const DEFAULT_RENAME_ATTEMPTS_WINDOWS = 12;
const DEFAULT_RENAME_ATTEMPTS_POSIX = 5;
const DEFAULT_RETRY_DELAY_MS_WINDOWS = 40;
const DEFAULT_RETRY_DELAY_MS_POSIX = 25;

function isWindows(): boolean {
  return process.platform === 'win32';
}

export async function writeFileAtomic(
  path: string,
  data: string | Buffer,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${Date.now()}-${randomBytes(3).toString('hex')}`,
  );
  try {
    const handle = await open(tmp, 'w', opts.mode ?? 0o600);
    try {
      await handle.writeFile(data);
      try {
        // Durability requires the temp file on disk before rename. Windows
        // cannot fsync directory handles, but file-handle sync is supported.
        await handle.sync();
      } catch (err) {
        if (!isIgnorableWindowsFsyncError(err)) throw err;
      }
    } finally {
      await handle.close();
    }
    try {
      await chmod(tmp, opts.mode ?? 0o600);
    } catch (err) {
      if (!isIgnorableWindowsPermError(err)) throw err;
    }
    await renameWithRetry(tmp, path, opts);
    if (!isWindows()) await fsyncDir(dirname(path));
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function renameWithRetry(
  from: string,
  to: string,
  opts: AtomicWriteOptions,
): Promise<void> {
  const maxAttempts = opts.maxRenameAttempts
    ?? (isWindows() ? DEFAULT_RENAME_ATTEMPTS_WINDOWS : DEFAULT_RENAME_ATTEMPTS_POSIX);
  const delayMs = opts.retryDelayMs
    ?? (isWindows() ? DEFAULT_RETRY_DELAY_MS_WINDOWS : DEFAULT_RETRY_DELAY_MS_POSIX);
  const rename = opts.rename ?? ((src, dest, fallback) => fallback(src, dest));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rename(from, to, fsRename);
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientRenameError(err) || attempt === maxAttempts) break;
      await sleep(delayMs * attempt);
    }
  }
  throw lastErr;
}

export function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

function isIgnorableWindowsPermError(err: unknown): boolean {
  if (!isWindows()) return false;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

function isIgnorableWindowsFsyncError(err: unknown): boolean {
  return isIgnorableWindowsPermError(err);
}

async function fsyncDir(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is best-effort across platforms.
  }
}

function sleep(ms: number): Promise<void> {
  // Use the timers module, not the global, so Vitest fake timers cannot
  // freeze Windows rename retries (AV / in-use destination files).
  return new Promise((resolve) => nativeSetTimeout(resolve, ms));
}
