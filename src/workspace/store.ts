import { readFile } from 'node:fs/promises';
import { paths } from '../config/paths';
import { writeFileAtomic } from '../platform/atomic-write';
import { PersistenceQueue } from '../platform/persistence-queue';
import { upgradeWorkspaceDocument, type WorkspaceDocumentV2 } from './store-format';

export class WorkspaceStore {
  private data: WorkspaceDocumentV2 = { schemaVersion: 2, chats: {}, named: {} };
  private queue = new PersistenceQueue();
  private loadFailure: { error: unknown } | undefined;
  private loading: Promise<void> | undefined;
  private readonly path: string;

  constructor(path: string = paths.workspacesFile) {
    this.path = path;
  }

  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.loadDocument().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async loadDocument(): Promise<void> {
    // Explicit reload drains old writes, including a failed queue, before reading.
    // Mutations remain blocked until the validated document is published.
    await this.queue.flush().catch(() => {});
    try {
      let text: string | undefined;
      try {
        text = await readFile(this.path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
      }
      const result = text === undefined
        ? { document: { schemaVersion: 2 as const, chats: {}, named: {} }, upgraded: true }
        : upgradeWorkspaceDocument(JSON.parse(text));
      if (result.upgraded) {
        await writeFileAtomic(this.path, `${JSON.stringify(result.document, null, 2)}\n`, { mode: 0o600 });
      }
      this.data = result.document;
      this.queue = new PersistenceQueue();
      this.loadFailure = undefined;
    } catch (error) {
      this.loadFailure = { error };
      throw error;
    }
  }

  cwdFor(chatId: string): string | undefined {
    return Object.hasOwn(this.data.chats, chatId) ? this.data.chats[chatId]?.cwd : undefined;
  }

  setCwd(chatId: string, cwd: string): void {
    this.assertMutable();
    Object.defineProperty(this.data.chats, chatId, { value: { cwd }, writable: true, enumerable: true, configurable: true });
    this.schedulePersist();
  }

  removeCwd(chatId: string): boolean {
    this.assertMutable();
    if (!Object.hasOwn(this.data.chats, chatId)) return false;
    delete this.data.chats[chatId];
    this.schedulePersist();
    return true;
  }

  listCwds(prefix?: string): Record<string, string> {
    return Object.fromEntries(Object.entries(this.data.chats)
      .filter(([key]) => !prefix || key.startsWith(prefix))
      .map(([key, value]) => [key, value.cwd]));
  }

  listNamed(): Record<string, string> {
    return { ...this.data.named };
  }

  getNamed(name: string): string | undefined {
    return Object.hasOwn(this.data.named, name) ? this.data.named[name] : undefined;
  }

  saveNamed(name: string, cwd: string): void {
    this.assertMutable();
    Object.defineProperty(this.data.named, name, { value: cwd, writable: true, enumerable: true, configurable: true });
    this.schedulePersist();
  }

  removeNamed(name: string): boolean {
    this.assertMutable();
    if (!Object.hasOwn(this.data.named, name)) return false;
    delete this.data.named[name];
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
    if (this.loading) throw new Error('Workspace store is loading');
    this.queue.assertHealthy();
  }

  private schedulePersist(): void {
    const snapshot = `${JSON.stringify(this.data, null, 2)}\n`;
    this.queue.enqueue(() => writeFileAtomic(this.path, snapshot, { mode: 0o600 }));
  }
}
