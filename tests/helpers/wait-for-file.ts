import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

/** Observe atomic fixture-file publication, including publication before subscription. */
export function waitForFile(path: string, accepts: (content: string) => boolean = () => true, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let settled = false;
    const watcher = watch(dirname(path), (_event, name) => {
      if (name === null || String(name) === basename(path)) void check();
    });
    watcher.on('error', fail);
    signal?.addEventListener('abort', abort, { once: true });
    async function check() {
      try {
        const content = await readFile(path, 'utf8');
        if (!settled && accepts(content)) finish();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail(error);
      }
    }
    function finish(error?: unknown) {
      if (settled) return;
      settled = true;
      watcher.close();
      signal?.removeEventListener('abort', abort);
      if (error === undefined) resolve();
      else reject(error);
    }
    function fail(error: unknown) { finish(error); }
    function abort() { fail(signal!.reason); }
    void check();
  });
}

/** Read the PID published by a scripted CLI fixture. */
export async function waitForPidFile(path: string, signal?: AbortSignal): Promise<number> {
  let pid = 0;
  await waitForFile(path, content => {
    const candidate = Number(content);
    if (!/^[1-9]\d*$/.test(content) || !Number.isSafeInteger(candidate)) return false;
    // Keep this accepted read: another read can observe a different file state.
    pid = candidate;
    return true;
  }, signal);
  return pid;
}
