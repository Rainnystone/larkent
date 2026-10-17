import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseFireKey, type PendingRecurring } from './schedule';
import { writeFileAtomic } from '../platform/atomic-write';
import { PersistenceQueue } from '../platform/persistence-queue';

export const AUTOMATIONS_SCHEMA_VERSION = 1 as const;
export const AUTOMATIONS_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export const AUTOMATIONS_MISSED_TTL_MS = 24 * 60 * 60 * 1000;
export const AUTOMATIONS_FIRE_HISTORY_MAX = 20;

export type AutomationTaskType = 'reminder' | 'agent';
export type AutomationLastStatus = 'ok' | 'missed' | 'failed' | 'running';
export type AutomationTriggerSource = 'startup' | 'link-recovered' | 'wake';
export type AutomationLogResult = 'missed' | 'catch-up';
export type MarkStartedResult = 'started' | 'already-started';

export interface AutomationFireRecord {
  fireAt: number;
  startedAt: number;
}

export interface MissedInstant {
  fireAt: number;
  recordedAt: number;
}

export interface AutomationItem {
  id: number;
  taskType: AutomationTaskType;
  schedule: unknown;
  timezone: string;
  startAt: number;
  endAt: number;
  nextFireAt: number;
  lastFireAt: number;
  paused: boolean;
  missed: number;
  lastStatus: AutomationLastStatus;
  fireHistory: AutomationFireRecord[];
  chatId: string;
  createdBy: string;
  name: string;
  taskText: string;
  cwd?: string;
  missedInstants: MissedInstant[];
}

export interface CreateAutomationInput {
  taskType: AutomationTaskType;
  schedule: unknown;
  timezone: string;
  startAt: number;
  endAt?: number;
  nextFireAt: number;
  chatId: string;
  createdBy: string;
  name: string;
  taskText: string;
  cwd?: string;
  paused?: boolean;
}

export interface AutomationDraft extends CreateAutomationInput {
  draftId: string;
  createdAt: number;
  cardMessageId?: string;
  pendingRecurring?: PendingRecurring;
}

export interface UpdateDraftPatch {
  schedule?: unknown;
  endAt?: number;
  nextFireAt?: number;
  pendingRecurring?: PendingRecurring | null;
  cardMessageId?: string;
}

export interface AutomationsLogEntry {
  id: number;
  taskType: AutomationTaskType;
  scheduledAt: number;
  decidedAt: number;
  triggerSource: AutomationTriggerSource;
  result: AutomationLogResult;
}

export interface AutomationBoardBinding {
  chatId: string;
  messageId: string;
  cardId?: string;
  sequence?: number;
  pinFailedHinted?: boolean;
}

export interface AutomationsStatusItem {
  id: number;
  paused: boolean;
  nextFireAt: number;
  lastFireAt: number;
  lastStatus: AutomationLastStatus;
  endAt: number;
  missed: number;
}

export interface AutomationsStatusSnapshot {
  v: 1;
  bot: string;
  updatedAt: number;
  items: AutomationsStatusItem[];
}

export interface AutomationsStoreOptions {
  path: string;
  logPath: string;
  statusPath: string;
  now?: () => number;
}

interface AutomationsDocument {
  nextId: number;
  items: AutomationItem[];
  drafts: AutomationDraft[];
  started: string[];
  boards: AutomationBoardBinding[];
}

export class AutomationsStore {
  private readonly path: string;
  private readonly logPath: string;
  private readonly statusPath: string;
  private readonly now: () => number;
  private nextId = 1;
  private items: AutomationItem[] = [];
  private drafts: AutomationDraft[] = [];
  private started = new Set<string>();
  private boards: AutomationBoardBinding[] = [];
  private logEntries: AutomationsLogEntry[] = [];
  private queue = new PersistenceQueue();
  private logQueue = new PersistenceQueue();
  private persistScheduled = false;
  private persistDirty = false;
  private loading: Promise<void> | undefined;
  private persistenceDisabled = false;
  private loadFailure: { error: unknown } | undefined;
  private hasDocument = false;

  constructor(opts: AutomationsStoreOptions) {
    this.path = opts.path;
    this.logPath = opts.logPath;
    this.statusPath = opts.statusPath;
    this.now = opts.now ?? Date.now;
  }

  getFilePath(): string {
    return this.path;
  }

  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.loadDocument().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  async flush(): Promise<void> {
    if (this.loading) await this.loading;
    if (this.loadFailure) throw this.loadFailure.error;
    if (this.persistenceDisabled) return;
    await this.queue.flush();
    await this.logQueue.flush();
  }

  list(): AutomationItem[] {
    return this.items.map((item) => this.viewItem(item));
  }

  hasAgedMissedInstants(): boolean {
    const cutoff = this.now() - AUTOMATIONS_MISSED_TTL_MS;
    return this.items.some((item) =>
      item.missedInstants.some((entry) => entry.recordedAt < cutoff),
    );
  }

  get(id: number): AutomationItem | undefined {
    const item = this.items.find((entry) => entry.id === id);
    return item ? this.viewItem(item) : undefined;
  }

  async create(input: CreateAutomationInput): Promise<AutomationItem> {
    this.assertMutable();
    if (input.taskType === 'agent' && !(typeof input.cwd === 'string' && input.cwd.trim())) {
      throw new Error('agent task requires cwd captured at creation');
    }
    const id = this.nextId;
    this.nextId += 1;
    const item: AutomationItem = {
      id,
      taskType: input.taskType,
      schedule: input.schedule,
      timezone: input.timezone,
      startAt: input.startAt,
      endAt: input.endAt ?? 0,
      nextFireAt: input.nextFireAt,
      lastFireAt: 0,
      paused: input.paused === true,
      missed: 0,
      lastStatus: 'ok',
      fireHistory: [],
      chatId: input.chatId,
      createdBy: input.createdBy,
      name: input.name,
      taskText: input.taskText,
      ...(input.taskType === 'agent' && input.cwd ? { cwd: input.cwd } : {}),
      missedInstants: [],
    };
    this.items.push(item);
    await this.persistNow();
    return cloneItem(item);
  }

  async delete(id: number): Promise<boolean> {
    this.assertMutable();
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1);
    await this.persistNow();
    return true;
  }

  async expire(id: number): Promise<boolean> {
    return this.delete(id);
  }

  async recordMissedInstant(id: number, fireAt: number): Promise<void> {
    this.assertMutable();
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return;
    if (item.missedInstants.some((entry) => entry.fireAt === fireAt)) return;
    item.missedInstants.push({ fireAt, recordedAt: this.now() });
    item.missed += 1;
    item.lastStatus = 'missed';
    await this.persistNow();
  }

  async recordLog(entry: AutomationsLogEntry): Promise<void> {
    this.assertMutable();
    this.logEntries.push({
      id: entry.id,
      taskType: entry.taskType,
      scheduledAt: entry.scheduledAt,
      decidedAt: entry.decidedAt,
      triggerSource: entry.triggerSource,
      result: entry.result,
    });
    await this.persistLogNow();
  }

  async readLog(): Promise<AutomationsLogEntry[]> {
    if (this.loading) await this.loading;
    return this.logEntries.map((entry) => ({ ...entry }));
  }

  async saveDraft(input: CreateAutomationInput & { pendingRecurring?: PendingRecurring }): Promise<AutomationDraft> {
    this.assertMutable();
    this.pruneDrafts();
    const draft: AutomationDraft = {
      ...input,
      draftId: `draft-${this.now()}-${randomBytes(4).toString('hex')}`,
      createdAt: this.now(),
    };
    this.drafts.push(draft);
    await this.persistNow();
    return { ...draft };
  }

  listDrafts(): AutomationDraft[] {
    this.pruneDrafts();
    return this.drafts.map((draft) => ({ ...draft }));
  }

  getDraft(draftId: string): AutomationDraft | undefined {
    this.pruneDrafts();
    const draft = this.drafts.find((entry) => entry.draftId === draftId);
    return draft ? { ...draft } : undefined;
  }

  findDraftByCardMessageId(cardMessageId: string): AutomationDraft | undefined {
    this.pruneDrafts();
    const draft = this.drafts.find((entry) => entry.cardMessageId === cardMessageId);
    return draft ? { ...draft } : undefined;
  }

  async bindDraftCard(draftId: string, cardMessageId: string): Promise<boolean> {
    this.assertMutable();
    this.pruneDrafts();
    const draft = this.drafts.find((entry) => entry.draftId === draftId);
    if (!draft) return false;
    draft.cardMessageId = cardMessageId;
    await this.persistNow();
    return true;
  }

  async takeDraft(draftId: string): Promise<AutomationDraft | undefined> {
    this.assertMutable();
    this.pruneDrafts();
    const index = this.drafts.findIndex((entry) => entry.draftId === draftId);
    if (index < 0) return undefined;
    const [draft] = this.drafts.splice(index, 1);
    if (!draft) return undefined;
    await this.persistNow();
    return { ...draft };
  }

  async updateDraft(draftId: string, patch: UpdateDraftPatch): Promise<AutomationDraft | undefined> {
    this.assertMutable();
    this.pruneDrafts();
    const draft = this.drafts.find((entry) => entry.draftId === draftId);
    if (!draft) return undefined;
    if (patch.schedule !== undefined) draft.schedule = patch.schedule;
    if (patch.endAt !== undefined) draft.endAt = patch.endAt;
    if (patch.nextFireAt !== undefined) draft.nextFireAt = patch.nextFireAt;
    if (patch.cardMessageId !== undefined) draft.cardMessageId = patch.cardMessageId;
    if (patch.pendingRecurring === null) delete draft.pendingRecurring;
    else if (patch.pendingRecurring !== undefined) draft.pendingRecurring = patch.pendingRecurring;
    await this.persistNow();
    return { ...draft };
  }

  async writeStatus(botDisplayName: string): Promise<void> {
    this.assertMutable();
    const snapshot = `${JSON.stringify(this.statusSnapshot(botDisplayName))}\n`;
    await writeFileAtomic(this.statusPath, snapshot, { mode: 0o600 });
  }

  async readStatus(): Promise<AutomationsStatusSnapshot | undefined> {
    try {
      return parseStatusDocument(await readFile(this.statusPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  getBoard(chatId: string): AutomationBoardBinding | undefined {
    const board = this.boards.find((entry) => entry.chatId === chatId);
    return board ? { ...board } : undefined;
  }

  findBoardByMessageId(messageId: string): AutomationBoardBinding | undefined {
    const board = this.boards.find((entry) => entry.messageId === messageId);
    return board ? { ...board } : undefined;
  }

  listBoards(): AutomationBoardBinding[] {
    return this.boards.map((board) => ({ ...board }));
  }

  async setBoard(binding: AutomationBoardBinding): Promise<void> {
    this.assertMutable();
    const index = this.boards.findIndex((entry) => entry.chatId === binding.chatId);
    const next: AutomationBoardBinding = {
      chatId: binding.chatId,
      messageId: binding.messageId,
      ...(binding.cardId ? { cardId: binding.cardId } : {}),
      ...(typeof binding.sequence === 'number' ? { sequence: binding.sequence } : {}),
      ...(binding.pinFailedHinted ? { pinFailedHinted: true } : {}),
    };
    if (index >= 0) this.boards[index] = next;
    else this.boards.push(next);
    await this.persistNow();
  }

  async markStarted(fireKey: string): Promise<MarkStartedResult> {
    this.assertMutable();
    if (this.started.has(fireKey)) return 'already-started';
    this.started.add(fireKey);
    const parsed = parseFireKey(fireKey);
    if (parsed) {
      const item = this.items.find((entry) => entry.id === parsed.id);
      if (item) {
        item.lastFireAt = parsed.fireAt;
        item.lastStatus = 'running';
        item.fireHistory = [
          ...item.fireHistory,
          { fireAt: parsed.fireAt, startedAt: this.now() },
        ].slice(-AUTOMATIONS_FIRE_HISTORY_MAX);
      }
    }
    await this.persistNow();
    return 'started';
  }

  hasStarted(fireKey: string): boolean {
    return this.started.has(fireKey);
  }

  async pause(id: number): Promise<boolean> {
    this.assertMutable();
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return false;
    item.paused = true;
    await this.persistNow();
    return true;
  }

  async resume(id: number, nextFireAt: number): Promise<boolean> {
    this.assertMutable();
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return false;
    item.paused = false;
    item.nextFireAt = nextFireAt;
    await this.persistNow();
    return true;
  }

  async setNextFireAt(
    id: number,
    nextFireAt: number,
    lastStatus?: AutomationLastStatus,
  ): Promise<boolean> {
    this.assertMutable();
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return false;
    item.nextFireAt = nextFireAt;
    if (lastStatus) item.lastStatus = lastStatus;
    await this.persistNow();
    return true;
  }

  private async loadDocument(): Promise<void> {
    await this.queue.flush().catch(() => {});
    try {
      let text: string | undefined;
      try {
        text = await readFile(this.path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
      }
      if (text === undefined) {
        this.publish(emptyDocument(), false, false);
        this.logEntries = await this.loadLogEntries();
        this.loadFailure = undefined;
        return;
      }
      const document = parseAutomationsDocument(text);
      this.publish(document, false, true);
      this.logEntries = await this.loadLogEntries();
      if (this.pruneDrafts()) this.schedulePersist();
      this.loadFailure = undefined;
    } catch (error) {
      this.publish(emptyDocument(), true, this.hasDocument);
      this.loadFailure = { error };
      throw error;
    }
  }

  private publish(document: AutomationsDocument, persistenceDisabled: boolean, hasDocument: boolean): void {
    this.nextId = document.nextId;
    this.items = document.items.map(cloneItem);
    this.drafts = document.drafts.map((draft) => ({ ...draft }));
    this.started = new Set(document.started);
    this.boards = document.boards.map((board) => ({ ...board }));
    this.persistenceDisabled = persistenceDisabled;
    this.hasDocument = hasDocument;
    this.persistScheduled = false;
    this.persistDirty = false;
    this.queue = new PersistenceQueue();
  }

  private pruneDrafts(): boolean {
    const cutoff = this.now() - AUTOMATIONS_DRAFT_TTL_MS;
    const before = this.drafts.length;
    this.drafts = this.drafts.filter((draft) => draft.createdAt > cutoff);
    return this.drafts.length !== before;
  }

  private viewItem(item: AutomationItem): AutomationItem {
    const cutoff = this.now() - AUTOMATIONS_MISSED_TTL_MS;
    const viewed = cloneItem(item);
    viewed.missedInstants = viewed.missedInstants.filter((entry) => entry.recordedAt >= cutoff);
    return viewed;
  }

  private assertMutable(): void {
    if (this.loading) throw new Error('automations store is loading');
    if (this.loadFailure) throw this.loadFailure.error;
    if (this.persistenceDisabled) throw new Error('automations store is not writable');
    this.queue.assertHealthy();
  }

  private async persistNow(): Promise<void> {
    this.hasDocument = true;
    this.schedulePersist();
    await this.flush();
  }

  private async persistLogNow(): Promise<void> {
    const entry = this.logEntries[this.logEntries.length - 1];
    if (!entry) return;
    const line = `${JSON.stringify(entry)}\n`;
    this.logQueue.enqueue(async () => {
      let previous = '';
      try {
        previous = await readFile(this.logPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
      }
      const prefix = previous.length === 0 || previous.endsWith('\n') ? previous : `${previous}\n`;
      await writeFileAtomic(this.logPath, `${prefix}${line}`, { mode: 0o600 });
    });
    await this.logQueue.flush();
  }

  private async loadLogEntries(): Promise<AutomationsLogEntry[]> {
    try {
      const text = await readFile(this.logPath, 'utf8');
      return parseLogDocument(text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return [];
      throw error;
    }
  }

  private schedulePersist(): void {
    if (this.persistenceDisabled || !this.hasDocument) return;
    try {
      this.queue.assertHealthy();
    } catch {
      return;
    }
    this.persistDirty = true;
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    this.queue.enqueue(async () => {
      try {
        while (this.persistDirty) {
          this.persistDirty = false;
          const snapshot = `${JSON.stringify(this.serialize(), null, 2)}\n`;
          await writeFileAtomic(this.path, snapshot, { mode: 0o600 });
        }
      } finally {
        this.persistScheduled = false;
      }
      if (this.persistDirty) this.schedulePersist();
    });
  }

  private statusSnapshot(botDisplayName: string): AutomationsStatusSnapshot {
    return {
      v: 1,
      bot: botDisplayName,
      updatedAt: this.now(),
      items: this.items.map((item) => ({
        id: item.id,
        paused: item.paused,
        nextFireAt: item.nextFireAt,
        lastFireAt: item.lastFireAt,
        lastStatus: item.lastStatus,
        endAt: item.endAt,
        missed: item.missed,
      })),
    };
  }

  private serialize(): {
    schemaVersion: typeof AUTOMATIONS_SCHEMA_VERSION;
    nextId: number;
    items: AutomationItem[];
    drafts: AutomationDraft[];
    started: string[];
    boards: AutomationBoardBinding[];
  } {
    return {
      schemaVersion: AUTOMATIONS_SCHEMA_VERSION,
      nextId: this.nextId,
      items: this.items.map(cloneItem),
      drafts: this.drafts.map((draft) => ({ ...draft })),
      started: [...this.started],
      boards: this.boards.map((board) => ({ ...board })),
    };
  }
}

function emptyDocument(): AutomationsDocument {
  return { nextId: 1, items: [], drafts: [], started: [], boards: [] };
}

function cloneItem(item: AutomationItem): AutomationItem {
  return {
    ...item,
    fireHistory: item.fireHistory.map((record) => ({ ...record })),
    missedInstants: item.missedInstants.map((entry) => ({ ...entry })),
  };
}

function parseAutomationsDocument(text: string): AutomationsDocument {
  const raw: unknown = JSON.parse(text);
  if (!isObject(raw)) throw new Error('Invalid automations document: expected object');
  if (raw.schemaVersion !== AUTOMATIONS_SCHEMA_VERSION) {
    throw new Error(`Unsupported automations schemaVersion: ${String(raw.schemaVersion)}`);
  }
  const nextId = typeof raw.nextId === 'number' && Number.isInteger(raw.nextId) && raw.nextId >= 1
    ? raw.nextId
    : 1;
  const items = Array.isArray(raw.items)
    ? raw.items.flatMap((entry) => {
      const item = parseItem(entry);
      return item ? [item] : [];
    })
    : [];
  const drafts = Array.isArray(raw.drafts)
    ? raw.drafts.flatMap((entry) => {
      const draft = parseDraft(entry);
      return draft ? [draft] : [];
    })
    : [];
  const started = Array.isArray(raw.started)
    ? raw.started.filter((key): key is string => typeof key === 'string' && key.length > 0)
    : [];
  const boards = Array.isArray(raw.boards)
    ? raw.boards.flatMap((entry) => {
      const board = parseBoard(entry);
      return board ? [board] : [];
    })
    : [];
  const maxItemId = items.reduce((max, item) => Math.max(max, item.id), 0);
  return {
    nextId: Math.max(nextId, maxItemId + 1),
    items,
    drafts,
    started,
    boards,
  };
}

function parseBoard(raw: unknown): AutomationBoardBinding | undefined {
  if (!isObject(raw)) return undefined;
  if (typeof raw.chatId !== 'string' || !raw.chatId) return undefined;
  if (typeof raw.messageId !== 'string' || !raw.messageId) return undefined;
  return {
    chatId: raw.chatId,
    messageId: raw.messageId,
    ...(typeof raw.cardId === 'string' && raw.cardId ? { cardId: raw.cardId } : {}),
    ...(isFiniteNumber(raw.sequence) ? { sequence: raw.sequence } : {}),
    ...(raw.pinFailedHinted === true ? { pinFailedHinted: true } : {}),
  };
}

function parseStatusDocument(text: string): AutomationsStatusSnapshot {
  const raw: unknown = JSON.parse(text);
  if (!isObject(raw) || raw.v !== 1 || typeof raw.bot !== 'string' || !isFiniteNumber(raw.updatedAt)) {
    throw new Error('Invalid automations status document');
  }
  const items = Array.isArray(raw.items)
    ? raw.items.flatMap((entry) => {
      const item = parseStatusItem(entry);
      return item ? [item] : [];
    })
    : [];
  return { v: 1, bot: raw.bot, updatedAt: raw.updatedAt, items };
}

function parseStatusItem(raw: unknown): AutomationsStatusItem | undefined {
  if (!isObject(raw) || !isPositiveInt(raw.id)) return undefined;
  if (!isFiniteNumber(raw.nextFireAt) || !isFiniteNumber(raw.lastFireAt) || !isFiniteNumber(raw.endAt)) {
    return undefined;
  }
  if (!isFiniteNumber(raw.missed) || !isLastStatus(raw.lastStatus)) return undefined;
  return {
    id: raw.id,
    paused: raw.paused === true,
    nextFireAt: raw.nextFireAt,
    lastFireAt: raw.lastFireAt,
    lastStatus: raw.lastStatus,
    endAt: raw.endAt,
    missed: raw.missed,
  };
}

function parseItem(raw: unknown): AutomationItem | undefined {
  if (!isObject(raw)) return undefined;
  if (!isPositiveInt(raw.id)) return undefined;
  if (raw.taskType !== 'reminder' && raw.taskType !== 'agent') return undefined;
  if (typeof raw.timezone !== 'string' || !raw.timezone) return undefined;
  if (!isFiniteNumber(raw.startAt) || !isFiniteNumber(raw.nextFireAt)) return undefined;
  if (typeof raw.chatId !== 'string' || !raw.chatId) return undefined;
  if (typeof raw.createdBy !== 'string' || !raw.createdBy) return undefined;
  if (typeof raw.name !== 'string' || typeof raw.taskText !== 'string') return undefined;
  const cwd = typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : undefined;
  if (raw.taskType === 'agent' && !cwd) return undefined;
  return {
    id: raw.id,
    taskType: raw.taskType,
    schedule: raw.schedule,
    timezone: raw.timezone,
    startAt: raw.startAt,
    endAt: isFiniteNumber(raw.endAt) ? raw.endAt : 0,
    nextFireAt: raw.nextFireAt,
    lastFireAt: isFiniteNumber(raw.lastFireAt) ? raw.lastFireAt : 0,
    paused: raw.paused === true,
    missed: isFiniteNumber(raw.missed) ? raw.missed : 0,
    lastStatus: isLastStatus(raw.lastStatus) ? raw.lastStatus : 'ok',
    fireHistory: parseFireHistory(raw.fireHistory),
    chatId: raw.chatId,
    createdBy: raw.createdBy,
    name: raw.name,
    taskText: raw.taskText,
    ...(cwd ? { cwd } : {}),
    missedInstants: parseMissedInstants(raw.missedInstants),
  };
}

function parseMissedInstants(raw: unknown): MissedInstant[] {
  if (!Array.isArray(raw)) return [];
  const instants: MissedInstant[] = [];
  for (const entry of raw) {
    if (isFiniteNumber(entry)) {
      instants.push({ fireAt: entry, recordedAt: entry });
      continue;
    }
    if (!isObject(entry) || !isFiniteNumber(entry.fireAt) || !isFiniteNumber(entry.recordedAt)) continue;
    instants.push({ fireAt: entry.fireAt, recordedAt: entry.recordedAt });
  }
  return instants;
}

function parseDraft(raw: unknown): AutomationDraft | undefined {
  if (!isObject(raw)) return undefined;
  if (typeof raw.draftId !== 'string' || !raw.draftId) return undefined;
  if (!isFiniteNumber(raw.createdAt)) return undefined;
  if (raw.taskType !== 'reminder' && raw.taskType !== 'agent') return undefined;
  if (typeof raw.timezone !== 'string' || !raw.timezone) return undefined;
  if (!isFiniteNumber(raw.startAt) || !isFiniteNumber(raw.nextFireAt)) return undefined;
  if (typeof raw.chatId !== 'string' || typeof raw.createdBy !== 'string') return undefined;
  if (typeof raw.name !== 'string' || typeof raw.taskText !== 'string') return undefined;
  return {
    draftId: raw.draftId,
    createdAt: raw.createdAt,
    taskType: raw.taskType,
    schedule: raw.schedule,
    timezone: raw.timezone,
    startAt: raw.startAt,
    ...(isFiniteNumber(raw.endAt) ? { endAt: raw.endAt } : {}),
    nextFireAt: raw.nextFireAt,
    chatId: raw.chatId,
    createdBy: raw.createdBy,
    name: raw.name,
    taskText: raw.taskText,
    ...(typeof raw.cwd === 'string' && raw.cwd ? { cwd: raw.cwd } : {}),
    ...(raw.paused === true ? { paused: true } : {}),
    ...(typeof raw.cardMessageId === 'string' && raw.cardMessageId ? { cardMessageId: raw.cardMessageId } : {}),
    ...(isPendingRecurring(raw.pendingRecurring) ? { pendingRecurring: raw.pendingRecurring } : {}),
  };
}

function isPendingRecurring(value: unknown): value is PendingRecurring {
  if (!isObject(value)) return false;
  return value.kind === 'daily' || value.kind === 'weekday' || value.kind === 'weekly' || value.kind === 'interval';
}

function parseFireHistory(raw: unknown): AutomationFireRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: AutomationFireRecord[] = [];
  for (const entry of raw) {
    if (!isObject(entry) || !isFiniteNumber(entry.fireAt) || !isFiniteNumber(entry.startedAt)) continue;
    records.push({ fireAt: entry.fireAt, startedAt: entry.startedAt });
  }
  return records.slice(-AUTOMATIONS_FIRE_HISTORY_MAX);
}

function isLastStatus(value: unknown): value is AutomationLastStatus {
  return value === 'ok' || value === 'missed' || value === 'failed' || value === 'running';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function parseLogDocument(text: string): AutomationsLogEntry[] {
  const entries: AutomationsLogEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = parseLogEntry(raw);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

function parseLogEntry(raw: unknown): AutomationsLogEntry | undefined {
  if (!isObject(raw)) return undefined;
  if (!isPositiveInt(raw.id)) return undefined;
  if (raw.taskType !== 'reminder' && raw.taskType !== 'agent') return undefined;
  if (!isFiniteNumber(raw.scheduledAt) || !isFiniteNumber(raw.decidedAt)) return undefined;
  if (raw.triggerSource !== 'startup' && raw.triggerSource !== 'link-recovered' && raw.triggerSource !== 'wake') {
    return undefined;
  }
  if (raw.result !== 'missed' && raw.result !== 'catch-up') return undefined;
  return {
    id: raw.id,
    taskType: raw.taskType,
    scheduledAt: raw.scheduledAt,
    decidedAt: raw.decidedAt,
    triggerSource: raw.triggerSource,
    result: raw.result,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
