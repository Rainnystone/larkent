import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { BackfillLedger } from '../../../src/bot/backfill-ledger';
import {
  WATERMARK_MARGIN_MS,
  createBackfillRun,
  formatBackfillLatenessHint,
  resolveBackfillWindow,
  runBackfill,
  type BackfillChannel,
  type RunBackfillDeps,
} from '../../../src/bot/backfill';
import { DEFAULT_BACKFILL_PREFERENCES, type BackfillPreferences } from '../../../src/config/schema';
import * as logger from '../../../src/core/logger';

const NOW = 1_760_000_000_000;
const BOT = 'ou_bot';
const USER = 'ou_user';
const CHAT_A = 'oc_chat_a';
const CHAT_B = 'oc_chat_b';
const CHAT_C = 'oc_chat_c';
const HOUR = 3_600_000;

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resolveBackfillWindow', () => {
  it('B5: 3 h freeze uses watermark minus 2 min, not the 6 h cap', () => {
    const lastLiveAt = NOW - 3 * HOUR;
    expect(resolveBackfillWindow({
      now: NOW,
      lastLiveAt,
      lookbackMs: DEFAULT_BACKFILL_PREFERENCES.lookbackMs,
    })).toEqual({
      gapMs: 3 * HOUR,
      windowStart: lastLiveAt - WATERMARK_MARGIN_MS,
      windowEnd: NOW,
    });
  });

  it('B5: 9 h freeze is capped at lookbackMs', () => {
    expect(resolveBackfillWindow({
      now: NOW,
      lastLiveAt: NOW - 9 * HOUR,
      lookbackMs: DEFAULT_BACKFILL_PREFERENCES.lookbackMs,
    })).toEqual({
      gapMs: 9 * HOUR,
      windowStart: NOW - DEFAULT_BACKFILL_PREFERENCES.lookbackMs,
      windowEnd: NOW,
    });
  });

  it('resumes from the earlier of lastLiveAt and lastBackfillEnd', () => {
    const lastLiveAt = NOW - HOUR;
    const lastBackfillEnd = NOW - 2 * HOUR;
    expect(resolveBackfillWindow({
      now: NOW,
      lastLiveAt,
      lastBackfillEnd,
      lookbackMs: DEFAULT_BACKFILL_PREFERENCES.lookbackMs,
    }).windowStart).toBe(lastBackfillEnd - WATERMARK_MARGIN_MS);
  });
});

describe('runBackfill', () => {
  it('B5: absent watermark initializes and does not scan', async () => {
    const h = await harness({ lastLiveAt: undefined });
    const info = spyInfo();
    await runBackfill(await deps(h));
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'watermark-initialized' }),
    );
    expect(h.listed).toHaveLength(0);
    expect(h.intake).toHaveLength(0);
    expect(h.ledger.getLiveAt()).toBe(NOW);
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
  });

  it('B5: gap below minGapMs skips without listing chats', async () => {
    const h = await harness({ lastLiveAt: NOW - 30_000 });
    const info = spyInfo();
    await runBackfill(await deps(h));
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'skip-short-gap', gapMs: 30_000 }),
    );
    expect(h.listed).toHaveLength(0);
    expect(h.intake).toHaveLength(0);
  });

  it('B5: enabled false skips without listing chats', async () => {
    const h = await harness();
    const info = spyInfo();
    await runBackfill(await deps({
      ...h,
      prefs: { ...DEFAULT_BACKFILL_PREFERENCES, enabled: false },
    }));
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'skip-disabled' }),
    );
    expect(h.listed).toHaveLength(0);
  });

  it('B5: missing bot identity skips without listing chats', async () => {
    const h = await harness();
    const info = spyInfo();
    await runBackfill(await deps({ ...h, botOpenId: null }));
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'skip-no-identity' }),
    );
    expect(h.listed).toHaveLength(0);
  });

  it('B5: clock skew rewrites the watermark and does not scan', async () => {
    const h = await harness({ lastLiveAt: NOW + 60_000 });
    const warn = spyWarn();
    await runBackfill(await deps(h));
    expect(events(warn, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'clock-skew' }),
    );
    expect(h.listed).toHaveLength(0);
    expect(h.ledger.getLiveAt()).toBe(NOW);
  });

  it('B1: a second trigger with the same history enqueues nothing', async () => {
    const mentions = [
      mentionItem('om_1', CHAT_A, 'one', NOW - 30_000),
      mentionItem('om_2', CHAT_A, 'two', NOW - 20_000),
      mentionItem('om_3', CHAT_A, 'three', NOW - 10_000),
    ];
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: mentions },
    });
    const first = spyInfo();
    await runBackfill(await deps(h));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_1', 'om_2', 'om_3']);
    expect(events(first, 'backfill').filter((row) => row.event === 'enqueued')).toHaveLength(3);

    h.intake.length = 0;
    h.ledger.touchLive(NOW - 5 * 60_000);
    const second = spyInfo();
    await runBackfill(await deps(h));
    expect(h.intake).toEqual([]);
    expect(events(second, 'backfill').filter((row) => row.event === 'skip-processed')).toHaveLength(3);
  });

  it('B4: keeps the newest raw page and newest mentions, recording the rest', async () => {
    const chatter = Array.from({ length: 220 }, (_, i) =>
      chatterItem(`om_raw_${i}`, CHAT_A, NOW - 300_000 + i * 100),
    );
    const mentions = Array.from({ length: 30 }, (_, i) =>
      mentionItem(`om_mention_${i}`, CHAT_A, `ask ${i}`, NOW - 20_000 + i * 100),
    );
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: [...chatter, ...mentions] },
    });
    const info = spyInfo();
    await runBackfill(await deps(h));

    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'raw-truncated' }),
    );
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'mentions-truncated', count: 10 }),
    );
    expect(h.intake.map((msg) => msg.messageId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `om_mention_${i + 10}`),
    );
    for (let i = 0; i < 10; i++) {
      expect(h.ledger.has(`om_mention_${i}`)).toBe(true);
    }
  });

  it('B7: registered slash commands are skipped', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: {
        [CHAT_A]: [
          mentionItem('om_stop', CHAT_A, '/stop', NOW - 20_000),
          mentionItem('om_ok', CHAT_A, 'please answer', NOW - 10_000),
        ],
      },
    });
    const info = spyInfo();
    await runBackfill(await deps(h));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_ok']);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'skip-command', msgId: 'om_stop' }),
    );
  });

  it('B8: one chat fetch failure does not block the others', async () => {
    const h = await harness({
      chats: [
        { id: CHAT_A, name: 'A' },
        { id: CHAT_B, name: 'B' },
        { id: CHAT_C, name: 'C' },
      ],
      messages: {
        [CHAT_A]: [mentionItem('om_a', CHAT_A, 'from a', NOW - 20_000)],
        [CHAT_C]: [mentionItem('om_c', CHAT_C, 'from c', NOW - 10_000)],
      },
      listErrors: { [CHAT_B]: Object.assign(new Error('rate limited'), { code: 99991400 }) },
    });
    const info = spyInfo();
    const warn = spyWarn();
    const metrics = spyMetrics();
    await runBackfill(await deps(h));

    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_a', 'om_c']);
    expect(events(warn, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'chat-fetch-failed', chatId: CHAT_B, code: 99991400 }),
    );
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'done', chats: 3, enqueuedTotal: 2 }),
    );
    expect(h.ledger.getLastBackfillEnd()).toBe(NOW);
    expect(metrics.mock.calls).toContainEqual(['backfill_chat_fetch_failed', 1]);
  });

  it('dry-run logs would-enqueue and does not intake or record survivors', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: [mentionItem('om_dry', CHAT_A, 'late mention', NOW - 15_000)] },
    });
    const info = spyInfo();
    await runBackfill(await deps({
      ...h,
      prefs: { ...DEFAULT_BACKFILL_PREFERENCES, dryRun: true },
    }));
    expect(h.intake).toEqual([]);
    expect(h.ledger.has('om_dry')).toBe(false);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'would-enqueue', msgId: 'om_dry', chatId: CHAT_A }),
    );
    expect(events(info, 'backfill').filter((row) => row.event === 'enqueued')).toEqual([]);
    expect(h.ledger.getLastBackfillEnd()).toBe(NOW);
    expect(h.ledger.getLiveAt()).toBe(NOW);
  });

  it('listChats failure aborts without advancing the watermark', async () => {
    const lastLiveAt = NOW - 5 * 60_000;
    const h = await harness({ lastLiveAt });
    const warn = spyWarn();
    await runBackfill(await deps({
      ...h,
      listChatsError: new Error('chats down'),
    }));
    expect(events(warn, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'chats-fetch-failed' }),
    );
    expect(h.intake).toEqual([]);
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
    expect(h.ledger.getLiveAt()).toBe(lastLiveAt);
  });

  it('drops deleted, self, and not-mentioned items; keeps other bots', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: {
        [CHAT_A]: [
          { ...mentionItem('om_del', CHAT_A, 'gone', NOW - 50_000), deleted: true },
          mentionItem('om_self', CHAT_A, 'I said this', NOW - 40_000, { senderId: BOT }),
          chatterItem('om_quiet', CHAT_A, NOW - 30_000),
          mentionItem('om_app', CHAT_A, 'another bot', NOW - 20_000, {
            senderId: 'ou_other_bot',
            senderType: 'app',
          }),
          mentionItem('om_user', CHAT_A, 'human', NOW - 10_000),
        ],
      },
    });
    const info = spyInfo();
    await runBackfill(await deps(h));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_app', 'om_user']);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'skip-deleted', msgId: 'om_del' }),
    );
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'skip-self', msgId: 'om_self' }),
    );
  });

  it('intersects chats override and personal allowlist, then caps maxChats', async () => {
    const h = await harness({
      chats: [
        { id: CHAT_A, name: 'A' },
        { id: CHAT_B, name: 'B' },
        { id: CHAT_C, name: 'C' },
      ],
      messages: {
        [CHAT_A]: [mentionItem('om_a', CHAT_A, 'a', NOW - 10_000)],
        [CHAT_B]: [mentionItem('om_b', CHAT_B, 'b', NOW - 10_000)],
        [CHAT_C]: [mentionItem('om_c', CHAT_C, 'c', NOW - 10_000)],
      },
    });
    const info = spyInfo();
    const known: Array<{ id: string; name: string }> = [];
    await runBackfill(await deps({
      ...h,
      prefs: { ...DEFAULT_BACKFILL_PREFERENCES, chats: [CHAT_B, CHAT_C], maxChats: 1 },
      profile: { mode: 'personal', access: { allowedChats: [CHAT_B, CHAT_C] } },
      refreshKnownChats: (chats) => {
        known.splice(0, known.length, ...chats);
      },
    }));
    expect(known.map((chat) => chat.id)).toEqual([CHAT_A, CHAT_B, CHAT_C]);
    expect(h.list).toEqual([CHAT_B]);
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_b']);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'chats-truncated', dropped: 1 }),
    );
  });

  it('logs topic-partial when a listed item carries thread_id', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: {
        [CHAT_A]: [mentionItem('om_topic', CHAT_A, 'in topic', NOW - 10_000, {
          threadId: 'omt_topic',
        })],
      },
    });
    const info = spyInfo();
    await runBackfill(await deps(h));
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'topic-partial', chatId: CHAT_A }),
    );
    expect(h.intake[0]?.threadId).toBe('omt_topic');
  });

  it('closing mid hand-off logs aborted and does not advance the watermark', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: {
        [CHAT_A]: [
          mentionItem('om_1', CHAT_A, 'first', NOW - 20_000),
          mentionItem('om_2', CHAT_A, 'second', NOW - 10_000),
        ],
      },
    });
    let closing = false;
    const info = spyInfo();
    await runBackfill(await deps({
      ...h,
      isClosing: () => closing,
      onIntake: () => {
        closing = true;
      },
    }));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_1']);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'aborted' }),
    );
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
  });

  it('logs trigger reconnected with gap and window bounds', async () => {
    const lastLiveAt = NOW - 5 * 60_000;
    const h = await harness({ lastLiveAt, chats: [{ id: CHAT_A, name: 'A' }] });
    const info = spyInfo();
    await runBackfill(await deps({ ...h, trigger: 'reconnected' }));
    const window = resolveBackfillWindow({
      now: NOW,
      lastLiveAt,
      lookbackMs: DEFAULT_BACKFILL_PREFERENCES.lookbackMs,
    });
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({
        event: 'trigger',
        trigger: 'reconnected',
        gapMs: window.gapMs,
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
      }),
    );
  });

  it('pages chat history with second-resolution bounds and bot-identity list', async () => {
    const lastLiveAt = NOW - 3 * HOUR;
    const h = await harness({
      lastLiveAt,
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: [mentionItem('om_1', CHAT_A, 'hi', NOW - 10_000)] },
    });
    await runBackfill(await deps(h));
    const window = resolveBackfillWindow({
      now: NOW,
      lastLiveAt,
      lookbackMs: DEFAULT_BACKFILL_PREFERENCES.lookbackMs,
    });
    expect(h.requests[0]).toEqual({
      container_id_type: 'chat',
      container_id: CHAT_A,
      start_time: String(Math.floor(window.windowStart / 1000)),
      end_time: String(Math.ceil(window.windowEnd / 1000)),
      sort_type: 'ByCreateTimeAsc',
      page_size: 50,
    });
  });
});

describe('createBackfillRun coalescing mutex', () => {
  it('returns the in-flight promise and logs coalesced for overlapping triggers', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: [mentionItem('om_1', CHAT_A, 'late', NOW - 10_000)] },
    });
    const run = createBackfillRun();
    const firstDeps = await deps({ ...h, listChatsHold: hold, trigger: 'reconnected' });
    const secondDeps = await deps({ ...h, listChatsHold: hold, trigger: 'connect' });
    const info = spyInfo();
    const first = run(firstDeps);
    const second = run(secondDeps);
    expect(second).toBe(first);
    expect(h.listed).toHaveLength(1);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'coalesced' }),
    );
    release();
    await first;
    expect(h.listed).toHaveLength(1);
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_1']);
  });

  it('starts a fresh scan after the in-flight one completes', async () => {
    let now = NOW;
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: [mentionItem('om_again', CHAT_A, 'again', NOW - 10_000)] },
    });
    const run = createBackfillRun();
    await run(await deps({ ...h, now: () => now }));
    expect(h.listed).toHaveLength(1);

    now = NOW + 5 * 60_000;
    h.intake.length = 0;
    const info = spyInfo();
    const next = await deps({ ...h, now: () => now, trigger: 'reconnected' });
    await run(next);
    expect(h.listed).toHaveLength(2);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'trigger', trigger: 'reconnected' }),
    );
    expect(events(info, 'backfill').filter((row) => row.event === 'coalesced')).toEqual([]);
  });

  it('does not share an in-flight scan across runner instances', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const leftH = await harness({ chats: [{ id: CHAT_A, name: 'A' }] });
    const rightH = await harness({ chats: [{ id: CHAT_B, name: 'B' }] });
    const left = createBackfillRun();
    const right = createBackfillRun();
    const info = spyInfo();
    const first = left(await deps({ ...leftH, listChatsHold: hold }));
    const second = right(await deps({ ...rightH, listChatsHold: hold }));
    expect(second).not.toBe(first);
    expect(leftH.listed).toHaveLength(1);
    expect(rightH.listed).toHaveLength(1);
    expect(events(info, 'backfill').filter((row) => row.event === 'coalesced')).toEqual([]);
    release();
    await Promise.all([first, second]);
  });
});

describe('formatBackfillLatenessHint', () => {
  it('names the delay once from the oldest marked create time', () => {
    const createTimeMs = Date.UTC(2026, 8, 11, 4, 7, 0);
    const hint = formatBackfillLatenessHint({
      createTimeMs,
      nowMs: createTimeMs + 12 * 60_000,
    });
    expect(hint).toMatch(/约 12 分钟前/);
    expect(hint).toContain('bridge 重连后才补处理');
    expect(hint).toBe(formatBackfillLatenessHint({
      createTimeMs,
      nowMs: createTimeMs + 12 * 60_000,
    }));
  });
});

async function harness(opts: {
  lastLiveAt?: number | undefined;
  chats?: Array<{ id: string; name: string }>;
  messages?: Record<string, Record<string, unknown>[]>;
  listErrors?: Record<string, Error>;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'backfill-'));
  dirs.push(dir);
  const ledger = new BackfillLedger(join(dir, 'backfill-state.json'), { now: () => NOW });
  await ledger.load();
  if (opts.lastLiveAt !== undefined) ledger.touchLive(opts.lastLiveAt);
  else if (!('lastLiveAt' in opts)) ledger.touchLive(NOW - 5 * 60_000);
  const listed: Array<{ pageSize?: number; maxPages?: number }> = [];
  const list: string[] = [];
  const intake: NormalizedMessage[] = [];
  const requests: Record<string, unknown>[] = [];
  return {
    ledger,
    listed,
    list,
    intake,
    requests,
    chats: opts.chats ?? [],
    messages: opts.messages ?? {},
    listErrors: opts.listErrors ?? {},
  };
}

async function deps(input: Awaited<ReturnType<typeof harness>> & {
  listChatsError?: Error;
  listChatsHold?: Promise<void>;
  prefs?: BackfillPreferences;
  profile?: { mode: 'team' | 'personal'; access: { allowedChats: string[] } };
  botOpenId?: string | null;
  trigger?: RunBackfillDeps['trigger'];
  now?: () => number;
  refreshKnownChats?: (chats: Array<{ id: string; name: string }>) => void;
  isClosing?: () => boolean;
  onIntake?: (msg: NormalizedMessage) => void;
}): Promise<RunBackfillDeps> {
  const channel = fakeChannel({
    identity: input.botOpenId === null ? undefined : { openId: input.botOpenId ?? BOT, name: 'Bot' },
    listed: input.listed,
    list: input.list,
    requests: input.requests,
    chats: input.chats,
    messages: input.messages,
    listErrors: input.listErrors,
    listChatsError: input.listChatsError,
    listChatsHold: input.listChatsHold,
  });
  const marks = new Map<string, { detectedAt: number }>();
  return {
    trigger: input.trigger ?? 'connect',
    channel,
    ledger: input.ledger,
    prefs: input.prefs ?? DEFAULT_BACKFILL_PREFERENCES,
    profile: input.profile ?? { mode: 'team', access: { allowedChats: [] } },
    now: input.now ?? (() => NOW),
    marks,
    isClosing: input.isClosing ?? (() => false),
    refreshKnownChats: input.refreshKnownChats,
    intake: async (msg) => {
      input.intake.push(msg);
      input.onIntake?.(msg);
      if (!input.prefs?.dryRun) input.ledger.record(msg.messageId, msg.createTime);
    },
  };
}

function fakeChannel(opts: {
  identity?: { openId: string; name: string };
  listed: Array<{ pageSize?: number; maxPages?: number }>;
  list: string[];
  requests: Record<string, unknown>[];
  chats: Array<{ id: string; name: string }>;
  messages: Record<string, Record<string, unknown>[]>;
  listErrors: Record<string, Error>;
  listChatsError?: Error;
  listChatsHold?: Promise<void>;
}): BackfillChannel {
  const pages = new Map<string, Record<string, unknown>[][]>();
  for (const [chatId, items] of Object.entries(opts.messages)) {
    pages.set(chatId, chunk(items, 50));
  }
  return {
    botIdentity: opts.identity,
    async listChats(query) {
      opts.listed.push(query ?? {});
      if (opts.listChatsHold) await opts.listChatsHold;
      if (opts.listChatsError) throw opts.listChatsError;
      return opts.chats;
    },
    async getChatMode() {
      return 'group';
    },
    async fetchRawMessage() {
      return [];
    },
    rawClient: {
      im: {
        v1: {
          message: {
            async list(req?: { params: Record<string, unknown> }) {
              const params = req?.params ?? {};
              const chatId = String(params.container_id ?? '');
              opts.list.push(chatId);
              opts.requests.push(params);
              const error = opts.listErrors[chatId];
              if (error) throw error;
              const chatPages = pages.get(chatId) ?? [[]];
              const token = typeof params.page_token === 'string' ? Number(params.page_token) : 0;
              const page = chatPages[token] ?? [];
              const next = token + 1;
              return {
                data: {
                  items: page,
                  has_more: next < chatPages.length,
                  ...(next < chatPages.length ? { page_token: String(next) } : {}),
                },
              };
            },
          },
        },
      },
    },
  };
}

function mentionItem(
  messageId: string,
  chatId: string,
  text: string,
  createTime: number,
  extra: {
    senderId?: string;
    senderType?: string;
    threadId?: string;
    deleted?: boolean;
  } = {},
): Record<string, unknown> {
  return {
    message_id: messageId,
    chat_id: chatId,
    msg_type: 'text',
    create_time: String(createTime),
    deleted: extra.deleted ?? false,
    sender: {
      id: extra.senderId ?? USER,
      id_type: 'open_id',
      sender_type: extra.senderType ?? 'user',
    },
    body: { content: JSON.stringify({ text: `@_user_1 ${text}` }) },
    mentions: [{ key: '@_user_1', id: BOT, id_type: 'open_id', name: 'Bot' }],
    ...(extra.threadId ? { thread_id: extra.threadId } : {}),
  };
}

function chatterItem(messageId: string, chatId: string, createTime: number): Record<string, unknown> {
  return {
    message_id: messageId,
    chat_id: chatId,
    msg_type: 'text',
    create_time: String(createTime),
    deleted: false,
    sender: { id: USER, id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: 'undirected' }) },
    mentions: [],
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out.length > 0 ? out : [[]];
}

function spyInfo() {
  return vi.spyOn(logger.log, 'info').mockImplementation(() => {});
}

function spyWarn() {
  return vi.spyOn(logger.log, 'warn').mockImplementation(() => {});
}

function spyMetrics() {
  return vi.spyOn(logger, 'reportMetric').mockImplementation(() => {});
}

function events(
  spy: { mock: { calls: unknown[][] } },
  phase: string,
): Array<{ event: string } & Record<string, unknown>> {
  return spy.mock.calls
    .filter((call) => call[0] === phase)
    .map((call) => ({ event: String(call[1]), ...(isRecord(call[2]) ? call[2] : {}) }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
