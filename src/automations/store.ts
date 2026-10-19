import { AUTOMATIONS_SCHEMA_VERSION, upgradeAutomationsDocument } from './migrations';
import { automationOperationScope, readAutomationOperationId } from './operation-id';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  cloneDraftCardBody,
  parseDraftCardBody,
  type DraftCardBody,
} from './card-body';
import type { PolicyGuardReason } from './policy-guard';
import { parseFireKey, type PendingRecurring } from './schedule';
import { writeFileAtomic } from '../platform/atomic-write';
import { PersistenceQueue } from '../platform/persistence-queue';

export { AUTOMATIONS_SCHEMA_VERSION } from './migrations';
export const AUTOMATIONS_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export const AUTOMATIONS_MISSED_TTL_MS = 24 * 60 * 60 * 1000;
export const AUTOMATIONS_FIRE_HISTORY_MAX = 20;
/** Started fire keys older than this are dropped so a long-lived process does not grow the set. */
export const AUTOMATIONS_STARTED_KEY_WINDOW_MS = 48 * 60 * 60 * 1000;

export type AutomationTaskType = 'reminder' | 'agent';
export type AutomationLastStatus = 'ok' | 'missed' | 'failed' | 'running';
export type AutomationTriggerSource = 'startup' | 'link-recovered' | 'wake' | 'timer' | 'confirm';
export type AutomationLogResult = 'missed' | 'catch-up' | 'policy-guard' | 'skipped';
export type AutomationPolicyGuardReason = PolicyGuardReason;
export type AutomationSkipReason = 'previous-run-unsettled';
export type { DraftCardBody };
export type MarkStartedResult = 'started' | 'already-started';

export interface AutomationFireRecord {
  fireAt: number;
  startedAt: number;
}

export interface MissedInstant {
  fireAt: number;
  recordedAt: number;
}

export interface SkippedInstant {
  fireAt: number;
  recordedAt: number;
  reason: AutomationSkipReason;
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
  skippedInstants: SkippedInstant[];
}

export interface AutomationOperation {
  operationId: string;
  aliases?: string[];
  profile: string;
  chatId: string;
  fingerprint: string;
  draftId: string;
  createdAt: number;
  state: 'received' | 'applied' | 'not-applied';
  code?: string;
  taskId?: number;
  dispatchedCount: number;
}
export type RegisterAutomationOperationInput = Pick<AutomationOperation, 'operationId' | 'profile' | 'chatId' | 'fingerprint'>;

export interface TaskMutationGuard {
  chatId: string;
  revision?: string;
  operationId?: string;
  operation?: RegisterAutomationOperationInput;
}

/** Management state only: firing a scheduled occurrence does not change the user's requested task. */
export function automationTargetRevision(item: AutomationItem): string {
  return createHash('sha256').update(JSON.stringify({ id: item.id, chatId: item.chatId, taskType: item.taskType, name: item.name,
    taskText: item.taskText, schedule: item.schedule, timezone: item.timezone, startAt: item.startAt, endAt: item.endAt, paused: item.paused, cwd: item.cwd })).digest('hex');
}

export function taskMutationError(item: AutomationItem | undefined, guard: TaskMutationGuard): string | undefined {
  if (!item || item.chatId !== guard.chatId) return 'target-not-found';
  if (guard.revision && guard.revision !== automationTargetRevision(item)) return 'target-state-conflict';
  return undefined;
}

export interface DraftDelivery {
  state: 'prepared' | 'sending' | 'sent' | 'rejected';
  deliveryId: string;
  card: object;
  cardId?: string;
}
export interface DraftCardReply {
  replyTo: string;
  replyInThread?: boolean;
  threadId?: string;
}
export interface CreateAutomationInput {
  cardReply?: DraftCardReply;
  operationId?: string;
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

export interface AutomationDraftBase {
  draftId: string;
  operationId?: string;
  delivery?: DraftDelivery;
  cardReply?: DraftCardReply;
  createdAt: number;
  chatId: string;
  createdBy: string;
  cardMessageId?: string;
  cardId?: string;
  sequence?: number;
  /** Rendered body captured when the card was registered. Settle reuses it. */
  cardBody?: DraftCardBody;
}

/** Frozen at proposal time so a later delete still leaves the card body intact. */
export interface AutomationTargetSnapshot {
  revision?: string;
  id: number;
  name: string;
  taskType: AutomationTaskType;
  scheduleLabel: string;
  nextFireLabel: string;
  endLabel: string;
}

export interface CreateAutomationDraft extends AutomationDraftBase, CreateAutomationInput {
  op: 'create';
  pendingRecurring?: PendingRecurring;
}

export interface DeleteAutomationDraft extends AutomationDraftBase {
  op: 'delete';
  targetId: number;
  target: AutomationTargetSnapshot;
}

export interface ReplaceAutomationDraft extends AutomationDraftBase, CreateAutomationInput {
  op: 'replace';
  targetId: number;
  target: AutomationTargetSnapshot;
  scheduleText?: string;
  pendingRecurring?: PendingRecurring;
}

export type AutomationDraft = CreateAutomationDraft | DeleteAutomationDraft | ReplaceAutomationDraft;

export type SaveAutomationDraftInput =
  | (CreateAutomationInput & { op?: 'create'; pendingRecurring?: PendingRecurring })
  | {
      op: 'delete';
      operationId?: string;
      cardReply?: DraftCardReply;
      chatId: string;
      createdBy: string;
      targetId: number;
      target: AutomationTargetSnapshot;
    }
  | (CreateAutomationInput & {
      op: 'replace';
      targetId: number;
      target: AutomationTargetSnapshot;
      scheduleText?: string;
      pendingRecurring?: PendingRecurring;
    });

export interface UpdateDraftPatch {
  cardReply?: DraftCardReply;
  schedule?: unknown;
  endAt?: number;
  nextFireAt?: number;
  pendingRecurring?: PendingRecurring | null;
  /** `null` drops the bound card so recovery can send a replacement. */
  cardMessageId?: string | null;
  cardId?: string;
  sequence?: number;
}

export interface AutomationsLogEntry {
  id: number;
  taskType: AutomationTaskType;
  scheduledAt: number;
  decidedAt: number;
  triggerSource?: AutomationTriggerSource;
  result: AutomationLogResult;
  reason?: AutomationPolicyGuardReason;
  skipReason?: AutomationSkipReason;
}

/** One still-pinned board waiting to be unpinned. A legacy id is only the message id. */
export interface PendingUnpinBoard {
  messageId: string;
  cardId?: string;
  sequence?: number;
  /** True after the buttonless settle update was accepted. */
  settled?: boolean;
}

export type PendingUnpinMessageRef = string | PendingUnpinBoard;

export interface AutomationBoardBinding {
  chatId: string;
  messageId: string;
  cardId?: string;
  sequence?: number;
  pinFailedHinted?: boolean;
  /**
   * Still-pinned previous boards. Message ids are unique.
   * Entries recorded on resend keep cardId and sequence so a later refresh can settle them.
   * A legacy `pendingUnpinMessageId` string loads as a one-element list.
   */
  pendingUnpinMessageIds?: PendingUnpinMessageRef[];
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
  operations: AutomationOperation[];
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
  private operations: AutomationOperation[] = [];
  private durableOperations: AutomationOperation[] = [];
  private durableItems: AutomationItem[] = [];
  private durableDrafts: AutomationDraft[] = [];
  private logEntries: AutomationsLogEntry[] = [];
  private queue = new PersistenceQueue();
  private logQueue = new PersistenceQueue();
  private statusQueue = new PersistenceQueue();
  private persistScheduled = false;
  private persistDirty = false;
  private loading: Promise<void> | undefined;
  private persistenceDisabled = false;
  private loadFailure: { error: unknown } | undefined;
  private hasDocument = false;
  private lastStatusUpdatedAt = 0;

  constructor(opts: AutomationsStoreOptions) {
    this.path = opts.path;
    this.logPath = opts.logPath;
    this.statusPath = opts.statusPath;
    this.now = opts.now ?? Date.now;
  }

  getFilePath(): string {
    return this.path;
  }

  getStatusPath(): string {
    return this.statusPath;
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
    await this.statusQueue.flush();
    await this.logQueue.flush();
  }

  listCommitted(): AutomationItem[] {
    this.assertMutable();
    return this.durableItems.map(item => this.viewItem(item));
  }

  list(): AutomationItem[] {
    return this.items.map((item) => this.viewItem(item));
  }

  /**
   * Delete missed and skipped rows whose TTL has passed.
   * Readers already hide them; leaving them in the document keeps the
   * scheduler rewriting status on every segment wake.
   */
  async dropAgedInstants(): Promise<boolean> {
    this.assertMutable();
    const cutoff = this.now() - AUTOMATIONS_MISSED_TTL_MS;
    let changed = false;
    for (const item of this.items) {
      const missed = item.missedInstants.filter((entry) => entry.recordedAt >= cutoff);
      const skipped = item.skippedInstants.filter((entry) => entry.recordedAt >= cutoff);
      if (
        missed.length === item.missedInstants.length
        && skipped.length === item.skippedInstants.length
      ) continue;
      item.missedInstants = missed;
      item.skippedInstants = skipped;
      changed = true;
    }
    if (changed) await this.persistNow();
    return changed;
  }

  /** Wall-clock instant when the oldest started fire key leaves the 48h window. */
  earliestStartedKeyExpiry(): number | undefined {
    let earliest = Number.POSITIVE_INFINITY;
    for (const key of this.started) {
      const parsed = parseFireKey(key);
      if (!parsed) continue;
      const expiry = parsed.fireAt + AUTOMATIONS_STARTED_KEY_WINDOW_MS + 1;
      if (expiry < earliest) earliest = expiry;
    }
    return Number.isFinite(earliest) ? earliest : undefined;
  }

  get(id: number): AutomationItem | undefined {
    const item = this.items.find((entry) => entry.id === id);
    return item ? this.viewItem(item) : undefined;
  }

  async create(input: CreateAutomationInput): Promise<AutomationItem> {
    const item = this.insertItem(input);
    await this.persistNow();
    return item;
  }

  async replace(draft: ReplaceAutomationDraft, input: CreateAutomationInput): Promise<AutomationItem | undefined> {
    this.assertMutable();
    const old = this.items.find(item => item.id === draft.targetId && item.chatId === draft.chatId);
    if (taskMutationError(old, { chatId: draft.chatId, revision: draft.target.revision })) return undefined;
    const created = this.insertItem({ ...input, ...(draft.operationId ? { operationId: draft.operationId } : {}) });
    this.items = this.items.filter(item => item.id !== draft.targetId);
    await this.persistNow();
    return created;
  }

  private insertItem(input: CreateAutomationInput): AutomationItem {
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
      skippedInstants: [],
    };
    if (input.operationId) this.settleAppliedOperation(input.operationId, item.id, 0);
    this.items.push(item);
    return cloneItem(item);
  }

  async delete(id: number, guard?: TaskMutationGuard): Promise<boolean> {
    this.assertMutable();
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0 || (guard && taskMutationError(this.items[index], guard))) return false;
    this.applyMutationOperation(id, guard);
    this.items.splice(index, 1);
    await this.persistNow();
    return true;
  }

  async expire(id: number): Promise<boolean> {
    return this.delete(id);
  }

  async removeChat(chatId: string): Promise<boolean> {
    this.assertMutable();
    const items = this.items.filter((item) => item.chatId !== chatId);
    const drafts = this.drafts.filter((draft) => draft.chatId !== chatId);
    const boards = this.boards.filter((board) => board.chatId !== chatId);
    const changed = items.length !== this.items.length
      || drafts.length !== this.drafts.length
      || boards.length !== this.boards.length;
    if (!changed) return false;
    this.items = items;
    for (const operation of this.operations) {
      if (operation.chatId === chatId && operation.state === 'received') { operation.state = 'not-applied'; operation.code = 'chat-unavailable'; }
    }
    this.drafts = drafts;
    this.boards = boards;
    await this.persistNow();
    return true;
  }

  async recordMissedInstant(id: number, fireAt: number): Promise<void> {
    await this.recordMissedInstants(id, [fireAt]);
  }

  async recordMissedInstants(id: number, fireAts: readonly number[]): Promise<void> {
    this.assertMutable();
    const item = this.items.find((entry) => entry.id === id);
    if (!item || fireAts.length === 0) return;
    const recorded = new Set(item.missedInstants.map((entry) => entry.fireAt));
    const recordedAt = this.now();
    let added = 0;
    for (const fireAt of fireAts) {
      if (recorded.has(fireAt)) continue;
      recorded.add(fireAt);
      item.missedInstants.push({ fireAt, recordedAt });
      added += 1;
    }
    if (added === 0) return;
    item.missed += added;
    if (item.lastStatus !== 'running') item.lastStatus = 'missed';
    await this.persistNow();
  }

  /**
   * Record a skipped slot and move nextFireAt in one write.
   * Does not change lastFireAt or lastStatus, so the in-flight run can still settle.
   */
  async recordSkippedFire(
    id: number,
    fireAt: number,
    reason: AutomationSkipReason,
    nextFireAt: number,
  ): Promise<boolean> {
    this.assertMutable();
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return false;
    if (!item.skippedInstants.some((entry) => entry.fireAt === fireAt)) {
      item.skippedInstants.push({ fireAt, recordedAt: this.now(), reason });
    }
    item.nextFireAt = nextFireAt;
    await this.persistNow();
    return true;
  }

  async recordLog(entry: AutomationsLogEntry): Promise<void> {
    await this.recordLogs([entry]);
  }

  async recordLogs(entries: readonly AutomationsLogEntry[]): Promise<void> {
    this.assertMutable();
    if (entries.length === 0) return;
    const mapped = entries.map((entry) => ({
      id: entry.id,
      taskType: entry.taskType,
      scheduledAt: entry.scheduledAt,
      decidedAt: entry.decidedAt,
      result: entry.result,
      ...(entry.triggerSource ? { triggerSource: entry.triggerSource } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.skipReason ? { skipReason: entry.skipReason } : {}),
    }));
    this.logEntries.push(...mapped);
    await this.persistLogLines(mapped);
  }

  async readLog(): Promise<AutomationsLogEntry[]> {
    if (this.loading) await this.loading;
    return this.logEntries.map((entry) => ({ ...entry }));
  }

  async saveDraft(
    input: CreateAutomationInput & { op?: 'create'; pendingRecurring?: PendingRecurring },
    operation?: RegisterAutomationOperationInput,
  ): Promise<CreateAutomationDraft>;
  async saveDraft(
    input: Extract<SaveAutomationDraftInput, { op: 'delete' }>,
    operation?: RegisterAutomationOperationInput,
  ): Promise<DeleteAutomationDraft>;
  async saveDraft(
    input: Extract<SaveAutomationDraftInput, { op: 'replace' }>,
    operation?: RegisterAutomationOperationInput,
  ): Promise<ReplaceAutomationDraft>;
  async saveDraft(input: SaveAutomationDraftInput, operation?: RegisterAutomationOperationInput): Promise<AutomationDraft> {
    this.assertMutable();
    this.pruneDrafts();
    const draftId = `draft-${this.now()}-${randomBytes(4).toString('hex')}`;
    const createdAt = this.now();
    const draft = draftFromInput(input, draftId, createdAt);
    if (operation) this.operations.push({ ...operation, draftId, createdAt, state: 'received', dispatchedCount: 0 });
    this.drafts.push(draft);
    await this.persistNow();
    return cloneDraft(draft);
  }

  getOperation(operationId: string): AutomationOperation | undefined {
    // Never report an uncommitted in-memory mutation as a durable result.
    this.assertMutable();
    const operation = this.durableOperations.find(entry => entry.operationId === operationId || entry.aliases?.includes(operationId));
    return operation ? cloneOperation(operation) : undefined;
  }

  getOperationDraft(draftId: string): AutomationDraft | undefined {
    this.assertMutable();
    const draft = this.durableDrafts.find(entry => entry.draftId === draftId);
    return draft ? cloneDraft(draft) : undefined;
  }

  async aliasOperation(operationId: string, alias: string): Promise<void> {
    this.assertMutable();
    const operation = this.operations.find(entry => entry.operationId === operationId);
    if (!operation) throw new Error('operation unavailable');
    if (operation.operationId === alias || operation.aliases?.includes(alias)) return;
    if (this.operations.some(entry => entry.operationId === alias || entry.aliases?.includes(alias))) throw new Error('operation alias conflict');
    operation.aliases = [...(operation.aliases ?? []), alias];
    await this.persistNow();
  }

  findReusableOperation(profile: string, chatId: string, fingerprint: string): AutomationOperation | undefined {
    this.assertMutable();
    const operation = this.operations.find(entry => entry.profile === profile && entry.chatId === chatId && entry.fingerprint === fingerprint
      && ((entry.state === 'applied' && entry.createdAt + AUTOMATIONS_DRAFT_TTL_MS > this.now())
        || (entry.state === 'received' && this.drafts.some(draft => draft.draftId === entry.draftId
          && draft.delivery?.state !== 'rejected'
          && (draft.delivery?.state === 'sending' || draft.createdAt + AUTOMATIONS_DRAFT_TTL_MS > this.now())))));
    return operation ? cloneOperation(operation) : undefined;
  }

  async setDraftDelivery(draftId: string, delivery: DraftDelivery): Promise<void> {
    this.assertMutable();
    const draft = this.drafts.find(entry => entry.draftId === draftId);
    if (!draft) throw new Error('draft unavailable');
    draft.delivery = structuredClone(delivery);
    await this.persistNow();
  }

  listDrafts(): AutomationDraft[] {
    this.pruneDrafts();
    return this.drafts.map((draft) => cloneDraft(draft));
  }

  getDraft(draftId: string): AutomationDraft | undefined {
    this.pruneDrafts();
    const draft = this.drafts.find((entry) => entry.draftId === draftId);
    return draft ? cloneDraft(draft) : undefined;
  }

  findDraftByCardMessageId(cardMessageId: string): AutomationDraft | undefined {
    this.pruneDrafts();
    const draft = this.drafts.find((entry) => entry.cardMessageId === cardMessageId);
    return draft ? cloneDraft(draft) : undefined;
  }

  async bindDraftCard(
    draftId: string,
    cardMessageId: string,
    cardId?: string,
    cardBody?: DraftCardBody,
  ): Promise<boolean> {
    this.assertMutable();
    this.pruneDrafts();
    const draft = this.drafts.find((entry) => entry.draftId === draftId);
    if (!draft) return false;
    draft.cardMessageId = cardMessageId;
    if (draft.delivery) draft.delivery.state = 'sent';
    if (cardId) draft.cardId = cardId;
    else delete draft.cardId;
    delete draft.sequence;
    if (cardBody) draft.cardBody = cloneDraftCardBody(cardBody);
    else delete draft.cardBody;
    await this.persistNow();
    return true;
  }

  listExpiredDrafts(): AutomationDraft[] {
    const cutoff = this.now() - AUTOMATIONS_DRAFT_TTL_MS;
    return this.drafts
      .filter((draft) => draft.createdAt <= cutoff && Boolean(draft.cardMessageId))
      .map((draft) => cloneDraft(draft));
  }

  async takeDraft(draftId: string): Promise<AutomationDraft | undefined> {
    this.assertMutable();
    this.pruneDrafts();
    const index = this.drafts.findIndex((entry) => entry.draftId === draftId);
    if (index < 0) return undefined;
    const [draft] = this.drafts.splice(index, 1);
    const operation = this.operations.find(entry => entry.draftId === draftId);
    if (operation && operation.state === 'received') { operation.state = 'not-applied'; operation.code = 'draft-closed'; }
    if (!draft) return undefined;
    await this.persistNow();
    return cloneDraft(draft);
  }

  async updateDraft(draftId: string, patch: UpdateDraftPatch): Promise<AutomationDraft | undefined> {
    this.assertMutable();
    this.pruneDrafts();
    const draft = this.drafts.find((entry) => entry.draftId === draftId);
    if (!draft) return undefined;
    if (draft.op !== 'delete') {
      if (patch.schedule !== undefined) draft.schedule = patch.schedule;
      if (patch.endAt !== undefined) draft.endAt = patch.endAt;
      if (patch.nextFireAt !== undefined) draft.nextFireAt = patch.nextFireAt;
      if (patch.pendingRecurring === null) delete draft.pendingRecurring;
      else if (patch.pendingRecurring !== undefined) draft.pendingRecurring = patch.pendingRecurring;
    }
    if (patch.cardReply) draft.cardReply = { ...patch.cardReply };
    if (patch.cardMessageId === null) {
      delete draft.delivery;
      delete draft.cardMessageId;
      delete draft.cardId;
      delete draft.sequence;
      delete draft.cardBody;
    } else if (patch.cardMessageId !== undefined) {
      draft.cardMessageId = patch.cardMessageId;
    }
    if (patch.cardId !== undefined) {
      if (patch.cardId) draft.cardId = patch.cardId;
      else delete draft.cardId;
    }
    if (patch.sequence !== undefined) {
      if (typeof patch.sequence === 'number') draft.sequence = patch.sequence;
      else delete draft.sequence;
    }
    await this.persistNow();
    return cloneDraft(draft);
  }

  async writeStatus(botDisplayName: string): Promise<void> {
    this.assertMutable();
    this.statusQueue.assertHealthy();
    // Snapshot inside the queued job so a later settleFire cannot be
    // overwritten by an in-flight stringify of lastStatus: running.
    this.statusQueue.enqueue(async () => {
      const snapshot = `${JSON.stringify(this.statusSnapshot(botDisplayName))}\n`;
      await writeFileAtomic(this.statusPath, snapshot, { mode: 0o600 });
    });
    await this.statusQueue.flush();
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
    return board ? cloneBoard(board) : undefined;
  }

  findBoardByMessageId(messageId: string): AutomationBoardBinding | undefined {
    const board = this.boards.find((entry) => entry.messageId === messageId);
    return board ? cloneBoard(board) : undefined;
  }

  listBoards(): AutomationBoardBinding[] {
    return this.boards.map((board) => cloneBoard(board));
  }

  async setBoard(binding: AutomationBoardBinding): Promise<void> {
    this.assertMutable();
    const index = this.boards.findIndex((entry) => entry.chatId === binding.chatId);
    const pendingUnpinMessageIds = normalizePendingUnpinMessageIds(
      binding.pendingUnpinMessageIds,
      binding.messageId,
    );
    const next: AutomationBoardBinding = {
      chatId: binding.chatId,
      messageId: binding.messageId,
      ...(binding.cardId ? { cardId: binding.cardId } : {}),
      ...(typeof binding.sequence === 'number' ? { sequence: binding.sequence } : {}),
      ...(binding.pinFailedHinted ? { pinFailedHinted: true } : {}),
      ...(pendingUnpinMessageIds.length > 0 ? { pendingUnpinMessageIds } : {}),
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
        for (const operation of this.operations) {
          if (operation.state === 'applied' && operation.taskId === item.id) operation.dispatchedCount++;
        }
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

  async pruneStartedFireKeys(now: number): Promise<boolean> {
    this.assertMutable();
    let changed = false;
    for (const key of [...this.started]) {
      const parsed = parseFireKey(key);
      if (!parsed) continue;
      if (now - parsed.fireAt <= AUTOMATIONS_STARTED_KEY_WINDOW_MS) continue;
      this.started.delete(key);
      changed = true;
    }
    if (changed) await this.persistNow();
    return changed;
  }

  private settleAppliedOperation(operationId: string, taskId: number, dispatchedCount: number): void {
    const operation = this.operations.find(entry => entry.operationId === operationId);
    if (!operation || operation.state !== 'received') throw new Error('operation is not awaiting confirmation');
    operation.state = 'applied'; operation.taskId = taskId; operation.dispatchedCount = dispatchedCount;
    this.drafts = this.drafts.filter(draft => draft.draftId !== operation.draftId);
  }

  private applyMutationOperation(id: number, guard?: TaskMutationGuard): void {
    // Receipt execution facts describe the linked task's lifetime, including fires before this mutation.
    const dispatchedCount = this.operations.reduce((count, entry) => entry.state === 'applied' && entry.taskId === id ? Math.max(count, entry.dispatchedCount) : count,
      this.items.find(item => item.id === id)?.fireHistory.length ?? 0);
    if (guard?.operation) {
      const operation = guard.operation;
      if (this.operations.some(entry => entry.operationId === operation.operationId || entry.aliases?.includes(operation.operationId))) throw new Error('operation already exists');
      this.operations.push({ ...operation, draftId: `operation:${operation.operationId}`, createdAt: this.now(), state: 'applied', taskId: id, dispatchedCount });
    }
    if (guard?.operationId) this.settleAppliedOperation(guard.operationId, id, dispatchedCount);
  }

  async recordOperationFailure(operation: RegisterAutomationOperationInput, code: string): Promise<void> {
    this.assertMutable();
    if (this.operations.some(entry => entry.operationId === operation.operationId || entry.aliases?.includes(operation.operationId))) throw new Error('operation already exists');
    this.operations.push({ ...operation, draftId: `operation:${operation.operationId}`, createdAt: this.now(), state: 'not-applied', code, dispatchedCount: 0 });
    await this.persistNow();
  }

  async rejectOperation(operationId: string, code: string): Promise<void> {
    this.assertMutable();
    const operation = this.operations.find(entry => entry.operationId === operationId);
    if (!operation || operation.state !== 'received') return;
    operation.state = 'not-applied'; operation.code = code;
    this.drafts = this.drafts.filter(draft => draft.draftId !== operation.draftId);
    await this.persistNow();
  }

  async pause(id: number, guard?: TaskMutationGuard): Promise<boolean> {
    this.assertMutable();
    const item = this.items.find((entry) => entry.id === id);
    if (!item || (guard && taskMutationError(item, guard))) return false;
    this.applyMutationOperation(id, guard);
    item.paused = true;
    await this.persistNow();
    return true;
  }

  async resume(id: number, nextFireAt: number, guard?: TaskMutationGuard): Promise<boolean> {
    this.assertMutable();
    const item = this.items.find((entry) => entry.id === id);
    if (!item || (guard && taskMutationError(item, guard))) return false;
    this.applyMutationOperation(id, guard);
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

  /**
   * Persist a terminal fire result. `failed` only from `running` (reap/crash).
   * `ok` may overwrite a raced reap `failed` from the still-live run.
   * Successful one-shots (`nextFireAt === 0`) are removed.
   */
  async settleFire(id: number, status: 'ok' | 'failed', fireKey?: string): Promise<boolean> {
    this.assertMutable();
    const index = this.items.findIndex((entry) => entry.id === id);
    const item = this.items[index];
    if (!item) return false;
    if (fireKey) {
      const parsed = parseFireKey(fireKey);
      if (!parsed || parsed.id !== id || item.lastFireAt !== parsed.fireAt) return false;
    }
    if (status === 'ok') {
      if (item.lastStatus !== 'running' && item.lastStatus !== 'failed') return false;
    } else if (item.lastStatus !== 'running') {
      return false;
    }
    item.lastStatus = status;
    if (status === 'ok' && item.nextFireAt === 0) {
      this.items.splice(index, 1);
    }
    await this.persistNow();
    return true;
  }

  private async loadDocument(): Promise<void> {
    await this.queue.flush().catch(() => {});
    await this.statusQueue.flush().catch(() => {});
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
        await this.loadStatusUpdatedAt();
        this.loadFailure = undefined;
        return;
      }
      const { document, upgraded } = parseAutomationsDocument(text);
      this.publish(document, false, true);
      if (upgraded) await this.persistNow();
      this.logEntries = await this.loadLogEntries();
      await this.loadStatusUpdatedAt();
      if (this.pruneDrafts()) this.schedulePersist();
      this.loadFailure = undefined;
    } catch (error) {
      this.publish(emptyDocument(), true, this.hasDocument);
      this.loadFailure = { error };
      throw error;
    }
  }

  private publish(document: AutomationsDocument, persistenceDisabled: boolean, hasDocument: boolean): void {
    this.durableItems = document.items.map(cloneItem);
    this.durableOperations = document.operations.map(cloneOperation);
    this.durableDrafts = document.drafts.map(cloneDraft);
    this.operations = document.operations.map(cloneOperation);
    this.nextId = document.nextId;
    this.items = document.items.map(cloneItem);
    this.drafts = document.drafts.map((draft) => ({ ...draft }));
    this.started = new Set(document.started);
    this.boards = document.boards.map((board) => cloneBoard(board));
    this.persistenceDisabled = persistenceDisabled;
    this.hasDocument = hasDocument;
    this.persistScheduled = false;
    this.persistDirty = false;
    this.queue = new PersistenceQueue();
    this.statusQueue = new PersistenceQueue();
  }

  private pruneDrafts(): boolean {
    const cutoff = this.now() - AUTOMATIONS_DRAFT_TTL_MS;
    const before = this.drafts.length;
    this.drafts = this.drafts.filter((draft) =>
      draft.createdAt > cutoff || Boolean(draft.cardMessageId) || draft.delivery?.state === 'sending',
    );
    return this.drafts.length !== before;
  }

  private viewItem(item: AutomationItem): AutomationItem {
    const cutoff = this.now() - AUTOMATIONS_MISSED_TTL_MS;
    const viewed = cloneItem(item);
    viewed.missedInstants = viewed.missedInstants.filter((entry) => entry.recordedAt >= cutoff);
    viewed.skippedInstants = viewed.skippedInstants.filter((entry) => entry.recordedAt >= cutoff);
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
    await this.queue.flush();
    await this.logQueue.flush();
  }

  private async persistLogLines(entries: readonly AutomationsLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const chunk = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    this.logQueue.enqueue(async () => {
      let previous = '';
      try {
        previous = await readFile(this.logPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
      }
      const prefix = previous.length === 0 || previous.endsWith('\n') ? previous : `${previous}\n`;
      await writeFileAtomic(this.logPath, `${prefix}${chunk}`, { mode: 0o600 });
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
          const document = this.serialize();
          const snapshot = `${JSON.stringify(document, null, 2)}\n`;
          await writeFileAtomic(this.path, snapshot, { mode: 0o600 });
          this.durableItems = document.items;
          this.durableOperations = document.operations;
          this.durableDrafts = document.drafts;
        }
      } finally {
        this.persistScheduled = false;
      }
      if (this.persistDirty) this.schedulePersist();
    });
  }

  private async loadStatusUpdatedAt(): Promise<void> {
    const snapshot = await this.readStatus();
    this.lastStatusUpdatedAt = snapshot?.updatedAt ?? 0;
  }

  private statusSnapshot(botDisplayName: string): AutomationsStatusSnapshot {
    const updatedAt = Math.max(this.now(), this.lastStatusUpdatedAt + 1);
    this.lastStatusUpdatedAt = updatedAt;
    return {
      v: 1,
      bot: botDisplayName,
      updatedAt,
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
    operations: AutomationOperation[];
  } {
    return {
      schemaVersion: AUTOMATIONS_SCHEMA_VERSION,
      nextId: this.nextId,
      items: this.items.map(cloneItem),
      drafts: this.drafts.map((draft) => cloneDraft(draft)),
      started: [...this.started],
      boards: this.boards.map((board) => cloneBoard(board)),
      operations: this.operations.map(cloneOperation),
    };
  }
}

function emptyDocument(): AutomationsDocument {
  return { nextId: 1, items: [], drafts: [], started: [], boards: [], operations: [] };
}

function cloneOperation(operation: AutomationOperation): AutomationOperation {
  return { ...operation, ...(operation.aliases ? { aliases: [...operation.aliases] } : {}) };
}

function cloneItem(item: AutomationItem): AutomationItem {
  return {
    ...item,
    fireHistory: item.fireHistory.map((record) => ({ ...record })),
    missedInstants: item.missedInstants.map((entry) => ({ ...entry })),
    skippedInstants: item.skippedInstants.map((entry) => ({ ...entry })),
  };
}

function parseAutomationsDocument(text: string): { document: AutomationsDocument; upgraded: boolean } {
  const { current: raw, upgraded } = upgradeAutomationsDocument(JSON.parse(text));
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
      if (isObject(entry) && (entry.operationId !== undefined || entry.delivery !== undefined) && !draft) throw new Error('Invalid automation operation draft');
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
  if (!Array.isArray(raw.operations)) throw new Error('Invalid automation operation receipts');
  const operations = raw.operations.map(parseOperation);
  const ids = new Set<string>();
  for (const operation of operations) {
    for (const id of [operation.operationId, ...(operation.aliases ?? [])]) {
      if (ids.has(id)) throw new Error('Invalid automation duplicate operation ID');
      ids.add(id);
    }
  }
  for (const draft of drafts) {
    if (!draft.operationId) continue;
    const operation = operations.find(entry => entry.operationId === draft.operationId);
    if (!operation || operation.draftId !== draft.draftId || operation.chatId !== draft.chatId) throw new Error('Invalid automation draft receipt association');
  }
  const maxItemId = items.reduce((max, item) => Math.max(max, item.id), 0);
  return { upgraded, document: { nextId: Math.max(nextId, maxItemId + 1), items, drafts, started, boards, operations } };
}

function parseOperation(raw: unknown): AutomationOperation {
  if (!isObject(raw) || typeof raw.operationId !== 'string' || typeof raw.profile !== 'string' || !raw.profile
    || typeof raw.chatId !== 'string' || !raw.chatId || typeof raw.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(raw.fingerprint)
    || typeof raw.draftId !== 'string' || !raw.draftId || !isFiniteNumber(raw.createdAt)
    || !Number.isSafeInteger(raw.dispatchedCount) || (raw.dispatchedCount as number) < 0
    || typeof raw.state !== 'string' || !['received', 'applied', 'not-applied'].includes(raw.state)
    || (raw.state === 'applied' && !isPositiveInt(raw.taskId))
    || (raw.taskId !== undefined && !isPositiveInt(raw.taskId))
    || (raw.code !== undefined && typeof raw.code !== 'string')
    || (raw.aliases !== undefined && !Array.isArray(raw.aliases))) throw new Error('Invalid automation operation receipt');
  const aliases = raw.aliases as unknown[] | undefined;
  for (const id of [raw.operationId, ...(aliases ?? [])]) {
    const parsed = readAutomationOperationId(id);
    if (!parsed || parsed.scope !== automationOperationScope(raw.profile, raw.chatId)) throw new Error('Invalid automation operation scope');
  }
  return {
    operationId: raw.operationId, profile: raw.profile, chatId: raw.chatId, fingerprint: raw.fingerprint, draftId: raw.draftId,
    createdAt: raw.createdAt, state: raw.state as AutomationOperation['state'], dispatchedCount: raw.dispatchedCount as number,
    ...(aliases ? { aliases: aliases as string[] } : {}), ...(raw.taskId ? { taskId: raw.taskId as number } : {}), ...(raw.code ? { code: raw.code as string } : {}),
  };
}

function parseDraftCardReply(raw: unknown): DraftCardReply {
  if (!isObject(raw) || typeof raw.replyTo !== 'string' || !raw.replyTo
    || (raw.replyInThread !== undefined && typeof raw.replyInThread !== 'boolean')
    || (raw.threadId !== undefined && (typeof raw.threadId !== 'string' || !raw.threadId))
    || (raw.replyInThread === true && !raw.threadId)) throw new Error('Invalid automation card reply');
  return { replyTo: raw.replyTo, ...(raw.replyInThread === true ? { replyInThread: true } : {}), ...(raw.threadId ? { threadId: raw.threadId as string } : {}) };
}

function parseDraftDelivery(raw: unknown): DraftDelivery {
  if (!isObject(raw) || typeof raw.state !== 'string' || !['prepared', 'sending', 'sent', 'rejected'].includes(raw.state)
    || typeof raw.deliveryId !== 'string' || !/^[a-f0-9]{32}$/.test(raw.deliveryId) || !isObject(raw.card)
    || (raw.cardId !== undefined && (typeof raw.cardId !== 'string' || !raw.cardId))
    || ((raw.state === 'sending' || raw.state === 'sent') && !raw.cardId)) throw new Error('Invalid automation draft delivery');
  return { state: raw.state as DraftDelivery['state'], deliveryId: raw.deliveryId, card: structuredClone(raw.card), ...(raw.cardId ? { cardId: raw.cardId as string } : {}) };
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
    ...pendingUnpinField(readPendingUnpinMessageIds(raw)),
  };
}

function readPendingUnpinMessageIds(raw: Record<string, unknown>): PendingUnpinMessageRef[] {
  const currentMessageId = typeof raw.messageId === 'string' ? raw.messageId : '';
  if (Array.isArray(raw.pendingUnpinMessageIds)) {
    return normalizePendingUnpinMessageIds(raw.pendingUnpinMessageIds, currentMessageId);
  }
  if (typeof raw.pendingUnpinMessageId === 'string') {
    return normalizePendingUnpinMessageIds([raw.pendingUnpinMessageId], currentMessageId);
  }
  return [];
}

function normalizePendingUnpinMessageIds(
  raw: readonly unknown[] | undefined,
  currentMessageId: string,
): PendingUnpinMessageRef[] {
  const refs = (raw ?? []).flatMap((entry) => {
    const parsed = parsePendingUnpinRef(entry, currentMessageId);
    return parsed ? [parsed] : [];
  });
  return dedupePendingUnpin(refs);
}

function parsePendingUnpinRef(raw: unknown, currentMessageId: string): PendingUnpinMessageRef | undefined {
  if (typeof raw === 'string') {
    if (!raw || raw === currentMessageId) return undefined;
    return raw;
  }
  if (!isObject(raw) || typeof raw.messageId !== 'string' || !raw.messageId) return undefined;
  if (raw.messageId === currentMessageId) return undefined;
  const cardId = typeof raw.cardId === 'string' && raw.cardId ? raw.cardId : undefined;
  const sequence = isPositiveInt(raw.sequence) ? raw.sequence : undefined;
  const settled = raw.settled === true;
  if (!cardId && sequence === undefined && !settled) return raw.messageId;
  return {
    messageId: raw.messageId,
    ...(cardId ? { cardId } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(settled ? { settled: true } : {}),
  };
}

function dedupePendingUnpin(refs: PendingUnpinMessageRef[]): PendingUnpinMessageRef[] {
  const order: string[] = [];
  const byId = new Map<string, PendingUnpinMessageRef>();
  for (const ref of refs) {
    const id = pendingUnpinRefMessageId(ref);
    const current = byId.get(id);
    if (!current) {
      order.push(id);
      byId.set(id, ref);
      continue;
    }
    byId.set(id, mergePendingUnpin(current, ref));
  }
  return order.flatMap((id) => {
    const ref = byId.get(id);
    return ref ? [ref] : [];
  });
}

function mergePendingUnpin(
  current: PendingUnpinMessageRef,
  incoming: PendingUnpinMessageRef,
): PendingUnpinMessageRef {
  const kept = asPendingUnpinBoard(current);
  const extra = asPendingUnpinBoard(incoming);
  const cardId = kept.cardId ?? extra.cardId;
  const sequence = kept.sequence ?? extra.sequence;
  const settled = kept.settled === true || extra.settled === true;
  if (!cardId && sequence === undefined && !settled) return kept.messageId;
  return {
    messageId: kept.messageId,
    ...(cardId ? { cardId } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(settled ? { settled: true } : {}),
  };
}

function asPendingUnpinBoard(ref: PendingUnpinMessageRef): PendingUnpinBoard {
  if (typeof ref === 'string') return { messageId: ref };
  return ref;
}

function pendingUnpinRefMessageId(ref: PendingUnpinMessageRef): string {
  if (typeof ref === 'string') return ref;
  return ref.messageId;
}

function pendingUnpinField(
  refs: PendingUnpinMessageRef[],
): { pendingUnpinMessageIds: PendingUnpinMessageRef[] } | Record<string, never> {
  if (refs.length === 0) return {};
  return { pendingUnpinMessageIds: refs };
}

function cloneBoard(board: AutomationBoardBinding): AutomationBoardBinding {
  return {
    ...board,
    ...(board.pendingUnpinMessageIds
      ? { pendingUnpinMessageIds: board.pendingUnpinMessageIds.map(clonePendingUnpin) }
      : {}),
  };
}

function clonePendingUnpin(ref: PendingUnpinMessageRef): PendingUnpinMessageRef {
  if (typeof ref === 'string') return ref;
  return { ...ref };
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
    skippedInstants: parseSkippedInstants(raw.skippedInstants),
  };
}

function parseSkippedInstants(raw: unknown): SkippedInstant[] {
  if (!Array.isArray(raw)) return [];
  const instants: SkippedInstant[] = [];
  for (const entry of raw) {
    if (!isObject(entry) || !isFiniteNumber(entry.fireAt) || !isFiniteNumber(entry.recordedAt)) continue;
    if (entry.reason !== 'previous-run-unsettled') continue;
    instants.push({ fireAt: entry.fireAt, recordedAt: entry.recordedAt, reason: entry.reason });
  }
  return instants;
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
  if (typeof raw.chatId !== 'string' || typeof raw.createdBy !== 'string') return undefined;
  const op = raw.op;
  if (op !== undefined && op !== 'create' && op !== 'delete' && op !== 'replace') return undefined;
  const card = {
    ...(typeof raw.operationId === 'string' ? { operationId: raw.operationId } : {}),
    ...(raw.cardReply !== undefined ? { cardReply: parseDraftCardReply(raw.cardReply) } : {}),
    ...(raw.delivery !== undefined ? { delivery: parseDraftDelivery(raw.delivery) } : {}),
    ...(typeof raw.cardMessageId === 'string' && raw.cardMessageId ? { cardMessageId: raw.cardMessageId } : {}),
    ...(typeof raw.cardId === 'string' && raw.cardId ? { cardId: raw.cardId } : {}),
    ...(isFiniteNumber(raw.sequence) ? { sequence: raw.sequence } : {}),
    ...parsedCardBody(raw.cardBody),
  };
  if (raw.delivery !== undefined && (typeof raw.operationId !== 'string' || !raw.operationId)) throw new Error('Invalid automation delivery association');
  if (card.delivery?.state === 'sent' && (!card.cardMessageId || card.cardId !== card.delivery.cardId)) throw new Error('Invalid automation delivery receipt');
  if (card.delivery && card.delivery.state !== 'sent' && card.cardMessageId) throw new Error('Invalid automation delivery state');
  if (op === 'delete') {
    const target = parseTargetSnapshot(raw.target);
    if (!isPositiveInt(raw.targetId) || !target || target.id !== raw.targetId) return undefined;
    return {
      op: 'delete',
      draftId: raw.draftId,
      createdAt: raw.createdAt,
      chatId: raw.chatId,
      createdBy: raw.createdBy,
      targetId: raw.targetId,
      target,
      ...card,
    };
  }
  const schedulable = parseSchedulableDraftFields(raw);
  if (!schedulable) return undefined;
  if (op === 'replace') {
    const target = parseTargetSnapshot(raw.target);
    if (!isPositiveInt(raw.targetId) || !target || target.id !== raw.targetId) return undefined;
    if (raw.scheduleText !== undefined && (typeof raw.scheduleText !== 'string' || !raw.scheduleText.trim())) return undefined;
    return {
      op: 'replace',
      ...schedulable,
      draftId: raw.draftId,
      createdAt: raw.createdAt,
      targetId: raw.targetId,
      target,
      ...(typeof raw.scheduleText === 'string' ? { scheduleText: raw.scheduleText.trim() } : {}),
      ...card,
    };
  }
  return {
    op: 'create',
    ...schedulable,
    draftId: raw.draftId,
    createdAt: raw.createdAt,
    ...card,
  };
}

function parseSchedulableDraftFields(raw: Record<string, unknown>): CreateAutomationInput & {
  pendingRecurring?: PendingRecurring;
} | undefined {
  if (raw.taskType !== 'reminder' && raw.taskType !== 'agent') return undefined;
  if (typeof raw.timezone !== 'string' || !raw.timezone) return undefined;
  if (!isFiniteNumber(raw.startAt) || !isFiniteNumber(raw.nextFireAt)) return undefined;
  if (typeof raw.chatId !== 'string' || typeof raw.createdBy !== 'string') return undefined;
  if (typeof raw.name !== 'string' || typeof raw.taskText !== 'string') return undefined;
  return {
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
    ...(isPendingRecurring(raw.pendingRecurring) ? { pendingRecurring: raw.pendingRecurring } : {}),
  };
}

function parseTargetSnapshot(raw: unknown): AutomationTargetSnapshot | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.revision !== undefined && (typeof raw.revision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.revision))) return undefined;
  if (!isPositiveInt(raw.id)) return undefined;
  if (raw.taskType !== 'reminder' && raw.taskType !== 'agent') return undefined;
  if (typeof raw.name !== 'string' || !raw.name) return undefined;
  if (typeof raw.scheduleLabel !== 'string' || !raw.scheduleLabel) return undefined;
  if (typeof raw.nextFireLabel !== 'string' || !raw.nextFireLabel) return undefined;
  if (typeof raw.endLabel !== 'string' || !raw.endLabel) return undefined;
  return {
    ...(typeof raw.revision === 'string' && /^[a-f0-9]{64}$/.test(raw.revision) ? { revision: raw.revision } : {}),
    id: raw.id,
    name: raw.name,
    taskType: raw.taskType,
    scheduleLabel: raw.scheduleLabel,
    nextFireLabel: raw.nextFireLabel,
    endLabel: raw.endLabel,
  };
}

function draftFromInput(input: SaveAutomationDraftInput, draftId: string, createdAt: number): AutomationDraft {
  if (input.op === 'delete') {
    return { ...input, op: 'delete', draftId, createdAt };
  }
  if (input.op === 'replace') {
    return { ...input, op: 'replace', draftId, createdAt };
  }
  return { ...input, op: 'create', draftId, createdAt };
}

function parsedCardBody(raw: unknown): { cardBody: DraftCardBody } | undefined {
  const cardBody = parseDraftCardBody(raw);
  return cardBody ? { cardBody } : undefined;
}

function cloneDraft(draft: AutomationDraft): AutomationDraft {
  draft = { ...draft, ...(draft.cardReply ? { cardReply: { ...draft.cardReply } } : {}), ...(draft.delivery ? { delivery: structuredClone(draft.delivery) } : {}) };
  const cardBody = draft.cardBody ? { cardBody: cloneDraftCardBody(draft.cardBody) } : {};
  switch (draft.op) {
    case 'delete':
      return { ...draft, target: { ...draft.target }, ...cardBody };
    case 'replace':
      return { ...draft, target: { ...draft.target }, ...cardBody };
    case 'create':
      return { ...draft, ...cardBody };
    default: {
      const _exhaustive: never = draft;
      return _exhaustive;
    }
  }
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
  if (
    raw.result !== 'missed'
    && raw.result !== 'catch-up'
    && raw.result !== 'policy-guard'
    && raw.result !== 'skipped'
  ) {
    return undefined;
  }
  const triggerSource =
    raw.triggerSource === 'startup'
    || raw.triggerSource === 'link-recovered'
    ||     raw.triggerSource === 'wake'
    || raw.triggerSource === 'timer'
    || raw.triggerSource === 'confirm'
      ? raw.triggerSource
      : undefined;
  if (raw.result !== 'policy-guard' && !triggerSource) return undefined;
  const reason = parsePolicyGuardReason(raw.reason);
  if (raw.result === 'policy-guard' && raw.reason !== undefined && !reason) return undefined;
  const skipReason = raw.skipReason === 'previous-run-unsettled' ? raw.skipReason : undefined;
  if (raw.result === 'skipped' && !skipReason) return undefined;
  return {
    id: raw.id,
    taskType: raw.taskType,
    scheduledAt: raw.scheduledAt,
    decidedAt: raw.decidedAt,
    result: raw.result,
    ...(triggerSource ? { triggerSource } : {}),
    ...(reason ? { reason } : {}),
    ...(skipReason ? { skipReason } : {}),
  };
}

function parsePolicyGuardReason(value: unknown): AutomationPolicyGuardReason | undefined {
  switch (value) {
    case 'auth-config':
    case 'members':
    case 'chat-create':
    case 'leave':
    case 'chat-settings':
    case 'contacts':
    case 'hr':
    case 'user-identity':
      return value;
    default:
      return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
