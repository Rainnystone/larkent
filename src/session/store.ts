import { readFile } from 'node:fs/promises';
import type { AgentKind } from '../agent/registry';
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
   * them from a different working directory. When `agentKind` is set, only
   * that CLI's handle is returned — another CLI's id must not be reused.
   */
  resumeFor(chatId: string, cwd: string, agentKind?: AgentKind): string | undefined {
    const entry = this.data[chatId];
    if (!entry) return undefined;
    if (agentKind) {
      const scoped = entry.byAgent?.[agentKind];
      if (scoped) return scoped.cwd === cwd ? scoped.resumeHandle : undefined;
      if (entry.agentKind === agentKind && entry.cwd === cwd) return entry.resumeHandle;
      return undefined;
    }
    if (entry.cwd !== cwd) return undefined;
    return entry.resumeHandle;
  }

  getRaw(chatId: string, agentKind?: AgentKind): SessionEntry | undefined {
    const entry = this.data[chatId];
    if (!entry) return undefined;
    if (!agentKind) return entry;
    const scoped = entry.byAgent?.[agentKind];
    if (scoped) {
      return { ...entry, resumeHandle: scoped.resumeHandle, cwd: scoped.cwd, agentKind };
    }
    if (entry.agentKind === agentKind) return entry;
    return {
      updatedAt: entry.updatedAt,
      ...(entry.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: entry.idleTimeoutMinutes }
        : {}),
    };
  }

  scopeIds(): string[] {
    return Object.keys(this.data);
  }

  set(chatId: string, resumeHandle: string, cwd: string, agentKind?: AgentKind): void {
    this.assertMutable();
    // Preserve idleTimeoutMinutes across run starts — it's a per-scope
    // preference, not per-run-instance state. Session resets preserve it.
    const prev = this.data[chatId];
    const byAgent = { ...prev?.byAgent };
    if (agentKind) byAgent[agentKind] = { resumeHandle, cwd };
    this.data[chatId] = {
      resumeHandle,
      cwd,
      updatedAt: Date.now(),
      ...(agentKind ? { agentKind } : prev?.agentKind ? { agentKind: prev.agentKind } : {}),
      ...(Object.keys(byAgent).length > 0 ? { byAgent } : {}),
      ...(prev?.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
        : {}),
    };
    this.schedulePersist();
  }

  clear(chatId: string, agentKind?: AgentKind): void {
    this.assertMutable();
    const prev = this.data[chatId];
    if (!prev) return;
    if (agentKind) {
      this.clearAgent(chatId, prev, agentKind);
      return;
    }
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

  private clearAgent(chatId: string, prev: SessionEntry, agentKind: AgentKind): void {
    const byAgent = { ...prev.byAgent };
    delete byAgent[agentKind];
    const remaining = Object.entries(byAgent) as Array<[AgentKind, { resumeHandle: string; cwd: string }]>;
    const keepLast = prev.agentKind && prev.agentKind !== agentKind
      ? { agentKind: prev.agentKind, resumeHandle: prev.resumeHandle, cwd: prev.cwd }
      : remaining[0]
        ? { agentKind: remaining[0][0], resumeHandle: remaining[0][1].resumeHandle, cwd: remaining[0][1].cwd }
        : undefined;
    if (!keepLast && prev.idleTimeoutMinutes === undefined) {
      delete this.data[chatId];
      this.schedulePersist();
      return;
    }
    this.data[chatId] = {
      updatedAt: Date.now(),
      ...(keepLast?.resumeHandle && keepLast.cwd
        ? { resumeHandle: keepLast.resumeHandle, cwd: keepLast.cwd, agentKind: keepLast.agentKind }
        : {}),
      ...(remaining.length > 0 ? { byAgent: Object.fromEntries(remaining) } : {}),
      ...(prev.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
        : {}),
    };
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
