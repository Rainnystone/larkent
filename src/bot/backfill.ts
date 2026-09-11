import { normalize, type LarkChannel, type NormalizedMessage, type RawMessageEvent } from '@larksuite/channel';
import { isRegisteredSlashCommand } from '../commands';
import type { BackfillPreferences } from '../config/schema';
import type { ProfileMode } from '../config/profile-schema';
import { log, reportMetric } from '../core/logger';
import type { BackfillLedger } from './backfill-ledger';
import type { KnownChat } from './lark-info';
import { createMergeForwardFetch } from './quote';

export const WATERMARK_MARGIN_MS = 120_000;

export type BackfillTrigger = 'connect' | 'reconnected';

export interface BackfillMark {
  detectedAt: number;
}

export interface BackfillChannel {
  botIdentity?: { openId: string; name?: string };
  listChats(opts?: { pageSize?: number; maxPages?: number }): Promise<Array<{ id: string; name: string }>>;
  getChatMode?(chatId: string): Promise<'p2p' | 'group' | 'topic'>;
  fetchRawMessage?: LarkChannel['fetchRawMessage'];
  rawClient: {
    im: {
      v1: {
        message: {
          list(req?: { params: Record<string, unknown> }): Promise<unknown>;
        };
      };
    };
  };
}

export interface RunBackfillDeps {
  trigger: BackfillTrigger;
  channel: BackfillChannel;
  ledger: BackfillLedger;
  prefs: BackfillPreferences;
  profile: { mode: ProfileMode; access: { allowedChats: string[] } };
  now?: () => number;
  marks: Map<string, BackfillMark>;
  isClosing?: () => boolean;
  refreshKnownChats?: (chats: KnownChat[]) => void;
  intake: (msg: NormalizedMessage) => Promise<void>;
}

export function resolveBackfillWindow(input: {
  now: number;
  lastLiveAt: number;
  lastBackfillEnd?: number;
  lookbackMs: number;
}): { gapMs: number; windowStart: number; windowEnd: number } {
  const anchor = input.lastBackfillEnd === undefined
    ? input.lastLiveAt
    : Math.min(input.lastLiveAt, input.lastBackfillEnd);
  return {
    gapMs: input.now - input.lastLiveAt,
    windowStart: Math.max(input.now - input.lookbackMs, anchor - WATERMARK_MARGIN_MS),
    windowEnd: input.now,
  };
}

export function formatBackfillLatenessHint(input: {
  createTimeMs: number;
  nowMs: number;
}): string {
  const ageMs = Math.max(0, input.nowMs - input.createTimeMs);
  const minutes = Math.max(1, Math.round(ageMs / 60_000));
  const when = new Date(input.createTimeMs);
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');
  return (
    `以下用户消息是在 bot 离线期间发出的（约 ${minutes} 分钟前，${hh}:${mm}），` +
    'bridge 重连后才补处理。如需，可先简短说明延迟原因再回答。'
  );
}

export async function runBackfill(deps: RunBackfillDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const startedAt = Date.now();
  const identity = deps.channel.botIdentity;
  if (!deps.prefs.enabled) {
    log.info('backfill', 'skip-disabled', gapFields(deps.ledger, now));
    return;
  }
  if (!identity?.openId) {
    log.info('backfill', 'skip-no-identity', gapFields(deps.ledger, now));
    return;
  }
  const lastLiveAt = deps.ledger.getLiveAt();
  if (lastLiveAt === undefined) {
    deps.ledger.touchLive(now);
    log.info('backfill', 'watermark-initialized');
    return;
  }
  if (lastLiveAt > now) {
    deps.ledger.touchLive(now);
    return;
  }
  const window = resolveBackfillWindow({
    now,
    lastLiveAt,
    lastBackfillEnd: deps.ledger.getLastBackfillEnd(),
    lookbackMs: deps.prefs.lookbackMs,
  });
  if (window.gapMs < deps.prefs.minGapMs) {
    log.info('backfill', 'skip-short-gap', { gapMs: window.gapMs });
    return;
  }

  log.info('backfill', 'trigger', {
    trigger: deps.trigger,
    gapMs: window.gapMs,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
  });

  let listed: Array<{ id: string; name: string }>;
  try {
    listed = await deps.channel.listChats({ pageSize: 100, maxPages: 5 });
  } catch (error) {
    log.warn('backfill', 'chats-fetch-failed', { err: errorMessage(error) });
    return;
  }
  deps.refreshKnownChats?.(listed.map((chat) => ({
    id: chat.id,
    name: chat.name || '(无名)',
  })));

  const inScope = selectInScopeChats(listed, deps.prefs, deps.profile);
  log.info('backfill', 'chats', {
    listed: listed.length,
    inScope: inScope.chats.length,
    truncated: inScope.dropped,
  });
  if (inScope.dropped > 0) {
    log.info('backfill', 'chats-truncated', { dropped: inScope.dropped });
  }

  let enqueuedTotal = 0;
  let fetchFailures = 0;
  let aborted = false;
  for (const chat of inScope.chats) {
    if (deps.isClosing?.()) {
      aborted = true;
      break;
    }
    const result = await scanChat({
      chatId: chat.id,
      window,
      now,
      deps,
      botOpenId: identity.openId,
    });
    if (result === 'aborted') {
      aborted = true;
      break;
    }
    if (result === 'fetch-failed') fetchFailures += 1;
    else enqueuedTotal += result.enqueued;
  }

  if (aborted) {
    log.info('backfill', 'aborted');
    return;
  }

  deps.ledger.markScanComplete(window.windowEnd, now);
  const durationMs = Date.now() - startedAt;
  log.info('backfill', 'done', {
    chats: inScope.chats.length,
    enqueuedTotal,
    durationMs,
    lastBackfillEnd: window.windowEnd,
  });
  reportMetric('backfill_enqueued', enqueuedTotal);
  reportMetric('backfill_duration_ms', durationMs);
  if (fetchFailures > 0) reportMetric('backfill_chat_fetch_failed', fetchFailures);
}

function selectInScopeChats(
  listed: Array<{ id: string; name: string }>,
  prefs: BackfillPreferences,
  profile: { mode: ProfileMode; access: { allowedChats: string[] } },
): { chats: Array<{ id: string; name: string }>; dropped: number } {
  let scoped = listed;
  if (prefs.chats.length > 0) {
    const allow = new Set(prefs.chats);
    scoped = scoped.filter((chat) => allow.has(chat.id));
  }
  switch (profile.mode) {
    case 'team':
      break;
    case 'personal': {
      const allow = new Set(profile.access.allowedChats);
      scoped = scoped.filter((chat) => allow.has(chat.id));
      break;
    }
    default: {
      const _exhaustive: never = profile.mode;
      return _exhaustive;
    }
  }
  const dropped = Math.max(0, scoped.length - prefs.maxChats);
  return {
    chats: dropped > 0 ? scoped.slice(0, prefs.maxChats) : scoped,
    dropped,
  };
}

async function scanChat(input: {
  chatId: string;
  window: { windowStart: number; windowEnd: number };
  now: number;
  deps: RunBackfillDeps;
  botOpenId: string;
}): Promise<{ enqueued: number } | 'fetch-failed' | 'aborted'> {
  const { chatId, window, now, deps, botOpenId } = input;
  let rawItems: HistoryItem[];
  try {
    rawItems = await listChatHistory(deps.channel, chatId, window, deps.prefs.maxRawPerChat);
  } catch (error) {
    log.warn('backfill', 'chat-fetch-failed', {
      chatId,
      err: errorMessage(error),
      ...(errorCode(error) !== undefined ? { code: errorCode(error) } : {}),
    });
    return 'fetch-failed';
  }

  if (await isTopicPartial(deps.channel, chatId, rawItems)) {
    log.info('backfill', 'topic-partial', { chatId });
  }

  const mentions: NormalizedMessage[] = [];
  let skippedProcessed = 0;
  let skippedCommand = 0;
  for (const item of rawItems) {
    const filtered = await filterHistoryItem(item, chatId, botOpenId, deps);
    if (filtered.kind === 'mention') mentions.push(filtered.msg);
    else if (filtered.kind === 'processed') skippedProcessed += 1;
    else if (filtered.kind === 'command') skippedCommand += 1;
  }

  const newestFirst = [...mentions].sort((a, b) => (
    b.createTime - a.createTime || (b.messageId < a.messageId ? -1 : b.messageId > a.messageId ? 1 : 0)
  ));
  const truncated = newestFirst.slice(deps.prefs.maxMentionsPerChat);
  const survivors = newestFirst.slice(0, deps.prefs.maxMentionsPerChat)
    .sort((a, b) => a.createTime - b.createTime || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0));
  if (truncated.length > 0) {
    log.info('backfill', 'mentions-truncated', { chatId, count: truncated.length });
    if (!deps.prefs.dryRun) {
      for (const msg of truncated) deps.ledger.record(msg.messageId, msg.createTime);
    }
  }

  let enqueued = 0;
  for (const msg of survivors) {
    if (deps.isClosing?.()) return 'aborted';
    const scope = msg.threadId ? `${msg.chatId}:${msg.threadId}` : msg.chatId;
    const fields = {
      chatId,
      msgId: msg.messageId,
      ageMs: Math.max(0, now - msg.createTime),
      scope,
    };
    if (deps.prefs.dryRun) {
      log.info('backfill', 'would-enqueue', fields);
      enqueued += 1;
      continue;
    }
    deps.marks.set(msg.messageId, { detectedAt: now });
    log.info('backfill', 'enqueued', fields);
    await deps.intake(msg);
    enqueued += 1;
  }

  log.info('backfill', 'chat-scanned', {
    chatId,
    raw: rawItems.length,
    mentions: mentions.length,
    enqueued,
    skippedProcessed,
    skippedCommand,
    truncated: truncated.length,
  });
  return { enqueued };
}

async function filterHistoryItem(
  item: HistoryItem,
  chatId: string,
  botOpenId: string,
  deps: RunBackfillDeps,
): Promise<
  | { kind: 'mention'; msg: NormalizedMessage }
  | { kind: 'processed' }
  | { kind: 'command' }
  | { kind: 'drop' }
> {
  if (item.deleted === true || !item.message_id) {
    log.info('backfill', 'skip-deleted', { msgId: item.message_id, chatId });
    return { kind: 'drop' };
  }
  if (item.sender?.id === botOpenId) {
    log.info('backfill', 'skip-self', { msgId: item.message_id, chatId });
    return { kind: 'drop' };
  }
  let msg: NormalizedMessage;
  try {
    msg = await normalizeHistoryItem(item, chatId, deps.channel, botOpenId);
  } catch (error) {
    log.warn('backfill', 'normalize-failed', {
      chatId,
      msgId: item.message_id,
      err: errorMessage(error),
    });
    return { kind: 'drop' };
  }
  if (!msg.mentionedBot) return { kind: 'drop' };
  if (deps.ledger.has(msg.messageId)) {
    log.info('backfill', 'skip-processed', { msgId: msg.messageId, chatId });
    return { kind: 'processed' };
  }
  if (isBackfillCommand(msg.content)) {
    log.info('backfill', 'skip-command', { msgId: msg.messageId, chatId });
    return { kind: 'command' };
  }
  return { kind: 'mention', msg };
}

async function normalizeHistoryItem(
  item: HistoryItem,
  chatId: string,
  channel: BackfillChannel,
  botOpenId: string,
): Promise<NormalizedMessage> {
  const mentions = mapMentions(item.mentions);
  const raw: RawMessageEvent = {
    sender: {
      sender_id: { ...(item.sender?.id ? { open_id: item.sender.id } : {}) },
      ...(item.sender?.sender_type ? { sender_type: item.sender.sender_type } : {}),
    },
    message: {
      message_id: item.message_id ?? '',
      chat_id: item.chat_id || chatId,
      chat_type: 'group',
      message_type: item.msg_type ?? 'text',
      content: item.body?.content ?? '',
      ...(item.create_time !== undefined ? { create_time: String(item.create_time) } : {}),
      ...(mentions ? { mentions } : {}),
      ...(item.thread_id ? { thread_id: item.thread_id } : {}),
      ...(item.root_id ? { root_id: item.root_id } : {}),
      ...(item.parent_id ? { parent_id: item.parent_id } : {}),
    },
  };
  const fetchRaw = channel.fetchRawMessage?.bind(channel);
  const fetchSubMessages = fetchRaw
    ? createMergeForwardFetch({ fetchRawMessage: fetchRaw })
    : async () => [];
  return normalize(raw, {
    botIdentity: {
      openId: botOpenId,
      name: channel.botIdentity?.name ?? '',
    },
    stripBotMentions: true,
    fetchSubMessages,
  });
}

async function listChatHistory(
  channel: BackfillChannel,
  chatId: string,
  window: { windowStart: number; windowEnd: number },
  maxRawPerChat: number,
): Promise<HistoryItem[]> {
  const kept: HistoryItem[] = [];
  let seen = 0;
  let pageToken: string | undefined;
  do {
    const res = await channel.rawClient.im.v1.message.list({
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        start_time: String(Math.floor(window.windowStart / 1000)),
        end_time: String(Math.ceil(window.windowEnd / 1000)),
        sort_type: 'ByCreateTimeAsc',
        page_size: 50,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    const data = asRecord(res)?.data;
    const payload = asRecord(data);
    const items = Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload?.messages)
        ? payload.messages
        : [];
    for (const raw of items) {
      const item = asHistoryItem(raw);
      if (!item) continue;
      seen += 1;
      kept.push(item);
      if (kept.length > maxRawPerChat) kept.shift();
    }
    pageToken = payload?.has_more === true && typeof payload.page_token === 'string'
      ? payload.page_token
      : undefined;
  } while (pageToken);
  if (seen > maxRawPerChat) {
    log.info('backfill', 'raw-truncated', {
      chatId,
      seen,
      kept: kept.length,
      dropped: seen - kept.length,
    });
  }
  return kept;
}

async function isTopicPartial(
  channel: BackfillChannel,
  chatId: string,
  items: HistoryItem[],
): Promise<boolean> {
  if (items.some((item) => Boolean(item.thread_id))) return true;
  if (!channel.getChatMode) return false;
  try {
    return await channel.getChatMode(chatId) === 'topic';
  } catch {
    return false;
  }
}

function isBackfillCommand(content: string): boolean {
  if (isRegisteredSlashCommand(content)) return true;
  const stripped = content.replace(/^@\S+\s+/, '').trim();
  return stripped !== content && isRegisteredSlashCommand(stripped);
}

function mapMentions(raw: unknown): NonNullable<RawMessageEvent['message']['mentions']> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const mentions: NonNullable<RawMessageEvent['message']['mentions']> = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.key !== 'string') continue;
    const id = entry.id;
    if (typeof id === 'string') {
      mentions.push({
        key: entry.key,
        id: { open_id: id },
        ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
      });
      continue;
    }
    if (isRecord(id)) {
      mentions.push({
        key: entry.key,
        id: {
          ...(typeof id.open_id === 'string' ? { open_id: id.open_id } : {}),
          ...(typeof id.user_id === 'string' ? { user_id: id.user_id } : {}),
          ...(typeof id.union_id === 'string' ? { union_id: id.union_id } : {}),
        },
        ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
      });
    }
  }
  return mentions.length > 0 ? mentions : undefined;
}

interface HistoryItem {
  message_id?: string;
  deleted?: boolean;
  chat_id?: string;
  thread_id?: string;
  root_id?: string;
  parent_id?: string;
  msg_type?: string;
  create_time?: string | number;
  body?: { content?: string };
  mentions?: unknown;
  sender?: { id?: string; sender_type?: string };
}

function asHistoryItem(raw: unknown): HistoryItem | undefined {
  if (!isRecord(raw)) return undefined;
  const sender = isRecord(raw.sender)
    ? {
        ...(typeof raw.sender.id === 'string' ? { id: raw.sender.id } : {}),
        ...(typeof raw.sender.sender_type === 'string' ? { sender_type: raw.sender.sender_type } : {}),
      }
    : undefined;
  const body = isRecord(raw.body) && typeof raw.body.content === 'string'
    ? { content: raw.body.content }
    : undefined;
  return {
    ...(typeof raw.message_id === 'string' ? { message_id: raw.message_id } : {}),
    ...(raw.deleted === true ? { deleted: true } : {}),
    ...(typeof raw.chat_id === 'string' ? { chat_id: raw.chat_id } : {}),
    ...(typeof raw.thread_id === 'string' ? { thread_id: raw.thread_id } : {}),
    ...(typeof raw.root_id === 'string' ? { root_id: raw.root_id } : {}),
    ...(typeof raw.parent_id === 'string' ? { parent_id: raw.parent_id } : {}),
    ...(typeof raw.msg_type === 'string' ? { msg_type: raw.msg_type } : {}),
    ...(typeof raw.create_time === 'string' || typeof raw.create_time === 'number'
      ? { create_time: raw.create_time }
      : {}),
    ...(body ? { body } : {}),
    ...(raw.mentions !== undefined ? { mentions: raw.mentions } : {}),
    ...(sender ? { sender } : {}),
  };
}

function gapFields(ledger: BackfillLedger, now: number): { gapMs?: number } {
  const lastLiveAt = ledger.getLiveAt();
  return lastLiveAt === undefined ? {} : { gapMs: now - lastLiveAt };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): number | string | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.code === 'number' || typeof error.code === 'string') return error.code;
  const nested = isRecord(error.response) && isRecord(error.response.data)
    ? error.response.data.code
    : undefined;
  return typeof nested === 'number' || typeof nested === 'string' ? nested : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
