import { readFile } from 'node:fs/promises';
import { paths } from '../config/paths';
import { writeFileAtomic } from '../platform/atomic-write';
import { PersistenceQueue } from '../platform/persistence-queue';
import { upgradeSessionDocument, type SessionEntry } from './store-format';

export type { SessionEntry } from './store-format';

type SessionMap = Record<string, SessionEntry>;

export class SessionStore {
  private data: SessionMap = Object.create(null);
  private queue = new PersistenceQueue();
  private loadFailure: { error: unknown } | undefined;
  private loading: Promise<void> | undefined;
  private readonly path: string;

  constructor(path: string = paths.sessionsFile) {
    this.path = path;
  }

  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.loadDocument().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async loadDocument(): Promise<void> {
    // Reload is the explicit recovery boundary: drain even a failed queue
    // before reading, and keep mutations blocked until publication completes.
    await this.queue.flush().catch(() => {});
    try {
      let text: string | undefined;
      try {
        text = await readFile(this.path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
      }
      const result = text === undefined
        ? { document: { schemaVersion: 2 as const, entries: Object.create(null) as SessionMap }, upgraded: true }
        : upgradeSessionDocument(JSON.parse(text));
      if (result.upgraded) {
        await writeFileAtomic(this.path, `${JSON.stringify(result.document, null, 2)}\n`, { mode: 0o600 });
      }
      this.data = result.document.entries;
      this.queue = new PersistenceQueue();
      this.loadFailure = undefined;
    } catch (error) {
      this.loadFailure = { error };
      throw error;
    }
  }

  /**
   * Return the session id for this chat if it was created in the given cwd.
   * Sessions recorded in a different cwd are stale — claude can't resume
   * them from a different working directory.
   */
  resumeFor(chatId: string, cwd: string): string | undefined {
    const entry = this.data[chatId];
    if (!entry) return undefined;
    if (entry.cwd !== cwd) return undefined;
    return entry.resumeHandle;
  }

  getRaw(chatId: string): SessionEntry | undefined {
    return this.data[chatId];
  }

  set(chatId: string, resumeHandle: string, cwd: string): void {
    this.assertMutable();
    // Preserve idleTimeoutMinutes across run starts — it's a per-scope
    // preference, not per-run-instance state. Session resets preserve it.
    const prev = this.data[chatId];
    this.data[chatId] = {
      resumeHandle,
      cwd,
      updatedAt: Date.now(),
      ...(prev?.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
        : {}),
    };
    this.schedulePersist();
  }

  clear(chatId: string): void {
    this.assertMutable();
    const prev = this.data[chatId];
    if (!prev) return;
    if (prev.idleTimeoutMinutes !== undefined) {
      this.data[chatId] = {
        idleTimeoutMinutes: prev.idleTimeoutMinutes,
        updatedAt: Date.now(),
      };
    } else {
      delete this.data[chatId];
    }
    this.schedulePersist();
  }

  /** Per-scope idle-timeout override. `undefined` means no override set. */
  getIdleTimeoutMinutes(chatId: string): number | undefined {
    return this.data[chatId]?.idleTimeoutMinutes;
  }

  setIdleTimeoutMinutes(chatId: string, minutes: number): void {
    this.assertMutable();
    if (Number.isNaN(minutes)) throw new Error('Invalid idle timeout');
    const clamped = Math.min(Math.max(Math.floor(minutes), 0), 120);
    const prev = this.data[chatId];
    this.data[chatId] = {
      ...(prev ?? { updatedAt: Date.now() }),
      idleTimeoutMinutes: clamped,
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  /** Remove the override so this scope falls back to the global default.
   * Returns true if something was actually removed. */
  clearIdleTimeoutOverride(chatId: string): boolean {
    this.assertMutable();
    const prev = this.data[chatId];
    if (!prev || prev.idleTimeoutMinutes === undefined) return false;
    const { idleTimeoutMinutes: _, ...rest } = prev;
    if (rest.resumeHandle !== undefined && rest.cwd !== undefined) {
      this.data[chatId] = { ...rest, updatedAt: Date.now() };
    } else {
      delete this.data[chatId];
    }
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    if (this.loading) await this.loading;
    if (this.loadFailure) throw this.loadFailure.error;
    await this.queue.flush();
  }

  private assertMutable(): void {
    if (this.loadFailure) throw this.loadFailure.error;
    if (this.loading) throw new Error('Session store is loading');
    this.queue.assertHealthy();
  }

  private schedulePersist(): void {
    const snapshot = `${JSON.stringify({ schemaVersion: 2, entries: this.data }, null, 2)}\n`;
    this.queue.enqueue(() => writeFileAtomic(this.path, snapshot, { mode: 0o600 }));
  }
}
