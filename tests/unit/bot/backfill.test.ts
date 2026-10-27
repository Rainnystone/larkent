import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { BackfillLedger } from '../../../src/bot/backfill-ledger';
import {
  BACKFILL_DELAY_LINE,
  WATERMARK_MARGIN_MS,
  createBackfillRun,
  formatBackfillLatenessHint,
  resolveBackfillWindow,
  runBackfill,
  type BackfillChannel,
  type RunBackfillDeps,
} from '../../../src/bot/backfill';
import {
  automationUnavailableForSender,
  senderTypeFromRaw,
} from '../../../src/bot/self-message';
import { DEFAULT_BACKFILL_PREFERENCES, type BackfillPreferences } from '../../../src/config/schema';
import * as logger from '../../../src/core/logger';

const NOW = 1_760_000_000_000;
const BOT = 'ou_bot';
const APP_ID = 'cli_bot';
const OTHER_APP = 'cli_other';
const USER = 'ou_user';
const CHAT_A = 'oc_chat_a';
const CHAT_B = 'oc_chat_b';
const CHAT_C = 'oc_chat_c';
const CHAT_P2P = 'oc_p2p';
const HOUR = 3_600_000;

const dirs: string[] = [];
const ledgers: BackfillLedger[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(ledgers.splice(0).map((ledger) => ledger.flush().catch(() => {})));
  await Promise.all(dirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
  ));
});

describe('resolveBackfillWindow', () => {
  it('B5: 3 h freeze uses watermark minus 2 min, not the 6 h cap', () => {
    const since = NOW - 3 * HOUR;
    expect(resolveBackfillWindow({
      now: NOW,
      since,
      lookbackMs: DEFAULT_BACKFILL_PREFERENCES.lookbackMs,
    })).toEqual({
      windowStart: since - WATERMARK_MARGIN_MS,
      windowEnd: NOW,
    });
  });

  it('B5: 9 h freeze is capped at lookbackMs', () => {
    expect(resolveBackfillWindow({
      now: NOW,
      since: NOW - 9 * HOUR,
      lookbackMs: DEFAULT_BACKFILL_PREFERENCES.lookbackMs,
    })).toEqual({
      windowStart: NOW - DEFAULT_BACKFILL_PREFERENCES.lookbackMs,
      windowEnd: NOW,
    });
  });

  it('keeps an incomplete origin after since has advanced', () => {
    expect(resolveBackfillWindow({
      now: NOW,
      since: NOW,
      incompleteFrom: NOW - HOUR,
      lookbackMs: DEFAULT_BACKFILL_PREFERENCES.lookbackMs,
    }).windowStart).toBe(NOW - HOUR - WATERMARK_MARGIN_MS);
  });
});

describe('runBackfill', () => {
  it('scans a 20-second gap instead of skipping it', async () => {
    const h = await harness({
      lastLiveAt: NOW - 20_000,
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: [mentionItem('om_gap', CHAT_A, 'during gap', NOW - 10_000)] },
    });
    const info = spyInfo();
    await runBackfill(await deps(h));
    expect(events(info, 'backfill').filter((row) => row.event === 'skip-short-gap')).toEqual([]);
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_gap']);
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
      expect(h.ledger.has(`om_mention_${i}`)).toBe(false);
    }
    expect(h.ledger.getIncompleteFrom()).toBe(NOW - 20_000);
    expect(h.requests).toHaveLength(4);
    expect(h.requests.every((params) => params.sort_type === 'ByCreateTimeDesc')).toBe(true);
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

  it('B8: one chat fetch failure does not block the others or advance completion', async () => {
    const lastLiveAt = NOW - 5 * 60_000;
    const h = await harness({
      lastLiveAt,
      chats: [
        { id: CHAT_A, name: 'A' },
        { id: CHAT_B, name: 'B' },
        { id: CHAT_C, name: 'C' },
      ],
      messages: {
        [CHAT_A]: [mentionItem('om_a', CHAT_A, 'from a', NOW - 20_000)],
        [CHAT_B]: [mentionItem('om_b', CHAT_B, 'from b', NOW - 15_000)],
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
      expect.objectContaining({ event: 'incomplete', chats: 3, enqueuedTotal: 2, fetchFailures: 1 }),
    );
    expect(events(info, 'backfill').filter((row) => row.event === 'done')).toEqual([]);
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
    expect(h.ledger.getLiveAt()).toBe(lastLiveAt);
    expect(h.ledger.getIncompleteFrom()).toBe(lastLiveAt);
    expect(metrics.mock.calls).toContainEqual(['backfill_chat_fetch_failed', 1]);

    delete h.listErrors[CHAT_B];
    h.intake.length = 0;
    h.ledger.touchLive(NOW);
    const retry = spyInfo();
    await runBackfill(await deps(h));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_b']);
    expect(events(retry, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'done', chats: 3, enqueuedTotal: 1 }),
    );
    expect(h.ledger.getLastBackfillEnd()).toBe(NOW);
    expect(h.ledger.getIncompleteFrom()).toBeUndefined();
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
    expect(h.ledger.getLiveAt()).toBe(NOW - 5 * 60_000);
  });

  it('listChats failure aborts without advancing the watermark', async () => {
    const lastLiveAt = NOW - 5 * 60_000;
    const h = await harness({ lastLiveAt });
    const info = spyInfo();
    const warn = spyWarn();
    await runBackfill(await deps({
      ...h,
      listChatsError: new Error('chats down'),
    }));
    expect(events(warn, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'chats-fetch-failed' }),
    );
    expect(h.intake).toEqual([]);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'incomplete' }),
    );
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
    expect(h.ledger.getLiveAt()).toBe(lastLiveAt);
    expect(h.ledger.getIncompleteFrom()).toBe(lastLiveAt);
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
    const ok = await runBackfill(await deps({
      ...h,
      isClosing: () => closing,
      onIntake: () => {
        closing = true;
      },
    }));
    expect(ok).toBe(false);
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_1']);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'aborted' }),
    );
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
    expect(h.ledger.getIncompleteFrom()).toBeDefined();

    closing = false;
    const resumed = await runBackfill(await deps({ ...h, isClosing: () => false }));
    expect(resumed).toBe(true);
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_1', 'om_2']);
  });

  it('marks the scan incomplete before listing chats so a crash keeps the window', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: [mentionItem('om_1', CHAT_A, 'hi', NOW - 10_000)] },
    });
    const pending = runBackfill(await deps({ ...h, listChatsHold: hold }));
    await waitUntil(() => h.listed.length >= 1);
    expect(h.ledger.getIncompleteFrom()).toBeDefined();
    release();
    expect(await pending).toBe(true);
    expect(h.ledger.getIncompleteFrom()).toBeUndefined();
  });

  it('answers a missed mention once after a crash mid-scan', async () => {
    const hold = new Promise<void>(() => {});
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: [mentionItem('om_crash', CHAT_A, 'missed', NOW - 10_000)] },
    });
    void runBackfill(await deps({ ...h, listChatsHold: hold }));
    await waitUntil(() => h.listed.length >= 1);
    await h.ledger.flush();

    const restarted = new BackfillLedger(h.ledger.getFilePath(), { now: () => NOW });
    ledgers.push(restarted);
    await restarted.load();
    expect(restarted.getIncompleteFrom()).toBeDefined();

    const intake: NormalizedMessage[] = [];
    const second = {
      ...h,
      ledger: restarted,
      listed: [] as typeof h.listed,
      list: [] as string[],
      intake,
      requests: [] as Record<string, unknown>[],
    };
    expect(await runBackfill(await deps(second))).toBe(true);
    expect(intake.map((msg) => msg.messageId)).toEqual(['om_crash']);
    expect(restarted.has('om_crash')).toBe(true);
    expect(restarted.getIncompleteFrom()).toBeUndefined();
    expect(h.intake).toEqual([]);
  });

  it('logs trigger with window bounds', async () => {
    const lastLiveAt = NOW - 5 * 60_000;
    const h = await harness({ lastLiveAt, chats: [{ id: CHAT_A, name: 'A' }] });
    const info = spyInfo();
    await runBackfill(await deps(h));
    const window = resolveBackfillWindow({
      now: NOW,
      since: lastLiveAt,
      lookbackMs: DEFAULT_BACKFILL_PREFERENCES.lookbackMs,
    });
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({
        event: 'trigger',
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
      }),
    );
  });

  it('enqueues a session-known p2p human message without mentions, then skips it on the next trigger', async () => {
    const h = await harness({
      chats: [],
      messages: { [CHAT_P2P]: [humanItem('om_dm', CHAT_P2P, '在？', NOW - 15_000)] },
    });
    const first = spyInfo();
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [CHAT_P2P],
      chatModes: { [CHAT_P2P]: 'p2p' },
    }));
    expect(h.list).toEqual([CHAT_P2P]);
    expect(h.intake).toHaveLength(1);
    expect(h.intake[0]?.messageId).toBe('om_dm');
    expect(h.intake[0]?.chatType).toBe('p2p');
    expect(h.intake[0]?.mentionedBot).toBe(false);
    expect(events(first, 'backfill').filter((row) => row.event === 'enqueued')).toHaveLength(1);

    h.intake.length = 0;
    h.ledger.touchLive(NOW - 5 * 60_000);
    const second = spyInfo();
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [CHAT_P2P],
      chatModes: { [CHAT_P2P]: 'p2p' },
    }));
    expect(h.intake).toEqual([]);
    expect(events(second, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'skip-processed', msgId: 'om_dm' }),
    );
  });

  it('does not enqueue bot-self or slash-command items from a session-known p2p chat', async () => {
    const h = await harness({
      chats: [],
      messages: {
        [CHAT_P2P]: [
          humanItem('om_self', CHAT_P2P, 'I said this', NOW - 30_000, { senderId: BOT }),
          humanItem('om_slash', CHAT_P2P, '/stop', NOW - 20_000),
          humanItem('om_ok', CHAT_P2P, 'please answer', NOW - 10_000),
        ],
      },
    });
    const info = spyInfo();
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [CHAT_P2P],
      chatModes: { [CHAT_P2P]: 'p2p' },
    }));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_ok']);
    expect(h.intake[0]?.chatType).toBe('p2p');
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'skip-self', msgId: 'om_self' }),
    );
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'skip-command', msgId: 'om_slash' }),
    );
  });

  it('skips a p2p reply whose sender id is the bot app id', async () => {
    const h = await harness({
      chats: [],
      messages: {
        [CHAT_P2P]: [
          humanItem('om_human', CHAT_P2P, '在？', NOW - 20_000),
          humanItem('om_reply', CHAT_P2P, 'answer', NOW - 10_000, {
            senderId: APP_ID,
            senderType: 'app',
          }),
        ],
      },
    });
    const info = spyInfo();
    await runBackfill(await deps({
      ...h,
      botAppId: APP_ID,
      sessionChatIds: [CHAT_P2P],
      chatModes: { [CHAT_P2P]: 'p2p' },
    }));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_human']);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'skip-self', msgId: 'om_reply', chatId: CHAT_P2P }),
    );
    expect(h.ledger.has('om_reply')).toBe(false);
  });

  it('skips a p2p item whose sender type is app even when the id is not this bot', async () => {
    const h = await harness({
      chats: [],
      messages: {
        [CHAT_P2P]: [
          humanItem('om_human', CHAT_P2P, '在？', NOW - 20_000),
          humanItem('om_other_app', CHAT_P2P, 'from another app', NOW - 10_000, {
            senderId: OTHER_APP,
            senderType: 'app',
          }),
        ],
      },
    });
    const info = spyInfo();
    await runBackfill(await deps({
      ...h,
      botAppId: APP_ID,
      sessionChatIds: [CHAT_P2P],
      chatModes: { [CHAT_P2P]: 'p2p' },
    }));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_human']);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'skip-self', msgId: 'om_other_app', chatId: CHAT_P2P }),
    );
  });

  it('skips a group mention whose sender id is the bot app id', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: {
        [CHAT_A]: [
          mentionItem('om_self_app', CHAT_A, 'I mentioned myself', NOW - 20_000, {
            senderId: APP_ID,
            senderType: 'app',
          }),
          mentionItem('om_human', CHAT_A, 'human', NOW - 10_000),
        ],
      },
    });
    const info = spyInfo();
    await runBackfill(await deps({ ...h, botAppId: APP_ID }));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_human']);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'skip-self', msgId: 'om_self_app', chatId: CHAT_A }),
    );
  });

  it('keeps a group mention from another app when the bot app id is known', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: {
        [CHAT_A]: [
          humanItem('om_other_quiet', CHAT_A, 'no mention', NOW - 30_000, {
            senderId: OTHER_APP,
            senderType: 'app',
          }),
          mentionItem('om_other_app', CHAT_A, 'another bot', NOW - 20_000, {
            senderId: OTHER_APP,
            senderType: 'app',
          }),
          mentionItem('om_human', CHAT_A, 'human', NOW - 10_000),
        ],
      },
    });
    await runBackfill(await deps({ ...h, botAppId: APP_ID }));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_other_app', 'om_human']);
  });

  it('does not enqueue the bot own replies on a second backfill of the same window', async () => {
    const history = [
      humanItem('om_human', CHAT_P2P, '在？', NOW - 30_000),
      humanItem('om_reply_a', CHAT_P2P, 'first answer', NOW - 20_000, {
        senderId: APP_ID,
        senderType: 'app',
      }),
    ];
    const h = await harness({
      chats: [],
      messages: { [CHAT_P2P]: history },
    });
    const accepted: string[] = [];
    const pass = async (): Promise<ReturnType<typeof spyInfo>> => {
      const info = spyInfo();
      await runBackfill(await deps({
        ...h,
        botAppId: APP_ID,
        sessionChatIds: [CHAT_P2P],
        chatModes: { [CHAT_P2P]: 'p2p' },
        onIntake: (msg) => {
          accepted.push(msg.messageId);
          // Mirror channel.ts recordAccepted so pass 2 only knows accepted inbound ids.
          const createTime = typeof msg.createTime === 'number' && Number.isFinite(msg.createTime)
            ? msg.createTime
            : NOW;
          h.ledger.record(msg.messageId, createTime);
        },
      }));
      return info;
    };

    const first = await pass();
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_human']);
    expect(h.ledger.has('om_human')).toBe(true);
    expect(h.ledger.has('om_reply_a')).toBe(false);
    expect(events(first, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'skip-self', msgId: 'om_reply_a', chatId: CHAT_P2P }),
    );

    history.push(humanItem('om_reply_b', CHAT_P2P, 'echo answer', NOW - 10_000, {
      senderId: APP_ID,
      senderType: 'app',
    }));
    h.intake.length = 0;
    h.ledger.touchLive(NOW - 5 * 60_000);

    const second = await pass();
    expect(h.intake).toEqual([]);
    expect(accepted).toEqual(['om_human']);
    expect(h.ledger.has('om_reply_a')).toBe(false);
    expect(h.ledger.has('om_reply_b')).toBe(false);
    expect(events(second, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'skip-processed', msgId: 'om_human', chatId: CHAT_P2P }),
    );
    expect(events(second, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'skip-self', msgId: 'om_reply_a', chatId: CHAT_P2P }),
    );
    expect(events(second, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'skip-self', msgId: 'om_reply_b', chatId: CHAT_P2P }),
    );
  });

  it('enqueues unmentioned group messages when requireMentionForChat is false', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: {
        [CHAT_A]: [
          chatterItem('om_quiet', CHAT_A, NOW - 20_000),
          mentionItem('om_mention', CHAT_A, 'please answer', NOW - 10_000),
        ],
      },
    });
    await runBackfill(await deps({
      ...h,
      requireMentionForChat: () => false,
    }));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_quiet', 'om_mention']);
  });

  it('recovers previously truncated mentions on a later scan when the cap is higher', async () => {
    const mentions = Array.from({ length: 3 }, (_, i) =>
      mentionItem(`om_cap_${i}`, CHAT_A, `ask ${i}`, NOW - 30_000 + i * 100),
    );
    const h = await harness({
      lastLiveAt: NOW - 5 * 60_000,
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: mentions },
    });
    await runBackfill(await deps({
      ...h,
      prefs: { ...DEFAULT_BACKFILL_PREFERENCES, maxMentionsPerChat: 1 },
    }));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_cap_2']);
    expect(h.ledger.has('om_cap_0')).toBe(false);
    expect(h.ledger.getIncompleteFrom()).toBeDefined();

    h.intake.length = 0;
    h.ledger.touchLive(NOW - 5 * 60_000);
    await runBackfill(await deps({
      ...h,
      prefs: { ...DEFAULT_BACKFILL_PREFERENCES, maxMentionsPerChat: 3 },
    }));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_cap_0', 'om_cap_1']);
  });

  it('keeps group @mention enqueue and still drops group messages without mentionedBot', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: {
        [CHAT_A]: [
          chatterItem('om_quiet', CHAT_A, NOW - 20_000),
          mentionItem('om_mention', CHAT_A, 'please answer', NOW - 10_000),
        ],
      },
    });
    await runBackfill(await deps(h));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_mention']);
    expect(h.intake[0]?.chatType).toBe('group');
    expect(h.intake[0]?.mentionedBot).toBe(true);
  });

  it('does not enqueue p2p when sessions are empty and listChats returns only groups', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: {
        [CHAT_A]: [chatterItem('om_group_quiet', CHAT_A, NOW - 20_000)],
        [CHAT_P2P]: [humanItem('om_hidden_dm', CHAT_P2P, '在？', NOW - 10_000)],
      },
    });
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [],
      chatModes: { [CHAT_P2P]: 'p2p' },
    }));
    expect(h.list).toEqual([CHAT_A]);
    expect(h.intake).toEqual([]);
  });

  it('dry-run logs would-enqueue for a session-known p2p message and does not intake', async () => {
    const h = await harness({
      chats: [],
      messages: { [CHAT_P2P]: [humanItem('om_dry_dm', CHAT_P2P, '在？', NOW - 15_000)] },
    });
    const info = spyInfo();
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [CHAT_P2P],
      chatModes: { [CHAT_P2P]: 'p2p' },
      prefs: { ...DEFAULT_BACKFILL_PREFERENCES, dryRun: true },
    }));
    expect(h.intake).toEqual([]);
    expect(h.ledger.has('om_dry_dm')).toBe(false);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'would-enqueue', msgId: 'om_dry_dm', chatId: CHAT_P2P }),
    );
    expect(events(info, 'backfill').filter((row) => row.event === 'enqueued')).toEqual([]);
  });

  it('caps newest human messages on a session-known p2p chat', async () => {
    const humans = Array.from({ length: 4 }, (_, i) =>
      humanItem(`om_p2p_${i}`, CHAT_P2P, `ask ${i}`, NOW - 40_000 + i * 100),
    );
    const h = await harness({
      chats: [],
      messages: { [CHAT_P2P]: humans },
    });
    const info = spyInfo();
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [CHAT_P2P],
      chatModes: { [CHAT_P2P]: 'p2p' },
      prefs: { ...DEFAULT_BACKFILL_PREFERENCES, maxMentionsPerChat: 2 },
    }));
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'mentions-truncated', chatId: CHAT_P2P, count: 2 }),
    );
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_p2p_2', 'om_p2p_3']);
    expect(h.intake.every((msg) => msg.chatType === 'p2p' && msg.mentionedBot === false)).toBe(true);
    expect(h.ledger.has('om_p2p_0')).toBe(false);
    expect(h.ledger.has('om_p2p_1')).toBe(false);
    expect(h.ledger.getIncompleteFrom()).toBe(NOW - 40_000);
  });

  it('preserves session-known p2p chats when maxChats truncates a long group list', async () => {
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
        [CHAT_P2P]: [humanItem('om_dm', CHAT_P2P, '在？', NOW - 10_000)],
      },
    });
    const info = spyInfo();
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [CHAT_P2P],
      chatModes: { [CHAT_P2P]: 'p2p' },
      prefs: { ...DEFAULT_BACKFILL_PREFERENCES, maxChats: 3 },
    }));
    expect(h.list).toEqual([CHAT_A, CHAT_B, CHAT_P2P]);
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_a', 'om_b', 'om_dm']);
    expect(h.intake.find((msg) => msg.messageId === 'om_dm')?.chatType).toBe('p2p');
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'chats-truncated', dropped: 1 }),
    );
  });

  it('keeps session-known p2p when prefs.chats allowlists groups', async () => {
    const h = await harness({
      chats: [
        { id: CHAT_A, name: 'A' },
        { id: CHAT_B, name: 'B' },
      ],
      messages: {
        [CHAT_A]: [mentionItem('om_a', CHAT_A, 'a', NOW - 10_000)],
        [CHAT_B]: [mentionItem('om_b', CHAT_B, 'b', NOW - 10_000)],
        [CHAT_P2P]: [humanItem('om_dm', CHAT_P2P, '在？', NOW - 10_000)],
      },
    });
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [CHAT_P2P],
      chatModes: { [CHAT_P2P]: 'p2p' },
      prefs: { ...DEFAULT_BACKFILL_PREFERENCES, chats: [CHAT_B] },
    }));
    expect(h.list).toEqual([CHAT_B, CHAT_P2P]);
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_b', 'om_dm']);
    expect(h.intake.find((msg) => msg.messageId === 'om_dm')?.chatType).toBe('p2p');
  });

  it('scans session-known p2p when listChats fails and keeps the incomplete window', async () => {
    const lastLiveAt = NOW - 5 * 60_000;
    const h = await harness({
      lastLiveAt,
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: {
        [CHAT_A]: [mentionItem('om_group', CHAT_A, 'from group', NOW - 20_000)],
        [CHAT_P2P]: [humanItem('om_dm', CHAT_P2P, '在？', NOW - 10_000)],
      },
    });
    const info = spyInfo();
    const warn = spyWarn();
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [CHAT_P2P],
      chatModes: { [CHAT_P2P]: 'p2p' },
      listChatsError: new Error('chats down'),
    }));
    expect(events(warn, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'chats-fetch-failed' }),
    );
    expect(h.list).toEqual([CHAT_P2P]);
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_dm']);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'incomplete', fetchFailures: 0, enqueuedTotal: 1 }),
    );
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
    expect(h.ledger.getIncompleteFrom()).toBe(lastLiveAt);

    h.intake.length = 0;
    h.ledger.touchLive(NOW);
    const retry = spyInfo();
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [CHAT_P2P],
      chatModes: { [CHAT_P2P]: 'p2p' },
    }));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_group']);
    expect(events(retry, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'done', enqueuedTotal: 1 }),
    );
    expect(h.ledger.getLastBackfillEnd()).toBe(NOW);
    expect(h.ledger.getIncompleteFrom()).toBeUndefined();
  });

  it('keeps the scan incomplete when session p2p mode lookup fails', async () => {
    const lastLiveAt = NOW - 5 * 60_000;
    const h = await harness({
      lastLiveAt,
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: {
        [CHAT_A]: [mentionItem('om_group', CHAT_A, 'from group', NOW - 20_000)],
        [CHAT_P2P]: [humanItem('om_dm', CHAT_P2P, '在？', NOW - 10_000)],
      },
    });
    const info = spyInfo();
    const warn = spyWarn();
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [CHAT_P2P],
      chatModeErrors: { [CHAT_P2P]: new Error('mode down') },
    }));
    expect(events(warn, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'mode-resolve-failed', chatId: CHAT_P2P }),
    );
    expect(h.list).toEqual([CHAT_A]);
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_group']);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({
        event: 'incomplete',
        modeLookupFailures: 1,
        fetchFailures: 0,
        enqueuedTotal: 1,
      }),
    );
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
    expect(h.ledger.getIncompleteFrom()).toBe(lastLiveAt);
  });

  it('completes an open incomplete scan when session p2p mode lookup returns HTTP 400, then still scans a short gap', async () => {
    const incompleteFrom = NOW - 6 * HOUR;
    const lastLiveAt = NOW - 11_000;
    let now = NOW;
    const { h } = await openIncompleteScan(lastLiveAt, incompleteFrom);
    const info = spyInfo();
    const warn = spyWarn();
    await runBackfill(await deps({
      ...h,
      now: () => now,
      sessionChatIds: [CHAT_P2P],
      chatModeErrors: { [CHAT_P2P]: httpStatusError(400) },
    }));

    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_group']);
    expect(h.list).toEqual([CHAT_A]);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'done', enqueuedTotal: 1 }),
    );
    expect(events(info, 'backfill').filter((row) => row.event === 'incomplete')).toEqual([]);
    expect(h.ledger.getIncompleteFrom()).toBeUndefined();
    expect(h.ledger.getLastBackfillEnd()).toBe(NOW);
    expect(events(warn, 'backfill')).toContainEqual(
      expect.objectContaining({
        event: 'mode-resolve-failed',
        chatId: CHAT_P2P,
        status: 400,
      }),
    );

    now = NOW + 11_000;
    const listedBefore = h.listed.length;
    const second = spyInfo();
    h.intake.length = 0;
    await runBackfill(await deps({
      ...h,
      now: () => now,
      sessionChatIds: [CHAT_P2P],
      chatModeErrors: { [CHAT_P2P]: httpStatusError(400) },
    }));
    expect(events(second, 'backfill').filter((row) => row.event === 'skip-short-gap')).toEqual([]);
    expect(h.listed.length).toBeGreaterThan(listedBefore);
    expect(h.intake).toEqual([]);
    expect(h.ledger.getIncompleteFrom()).toBeUndefined();
  });

  it('keeps the incomplete scan when session p2p mode lookup returns HTTP 500', async () => {
    const incompleteFrom = NOW - 6 * HOUR;
    const { h } = await openIncompleteScan(NOW - 11_000, incompleteFrom);
    const info = spyInfo();
    const warn = spyWarn();
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [CHAT_P2P],
      chatModeErrors: { [CHAT_P2P]: httpStatusError(500) },
    }));
    expect(events(warn, 'backfill')).toContainEqual(
      expect.objectContaining({
        event: 'mode-resolve-failed',
        chatId: CHAT_P2P,
        status: 500,
      }),
    );
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({
        event: 'incomplete',
        modeLookupFailures: 1,
        fetchFailures: 0,
        enqueuedTotal: 1,
      }),
    );
    expect(events(info, 'backfill').filter((row) => row.event === 'done')).toEqual([]);
    expect(h.ledger.getIncompleteFrom()).toBe(incompleteFrom);
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
  });

  it('keeps the incomplete scan when session p2p mode lookup returns HTTP 429', async () => {
    const incompleteFrom = NOW - 6 * HOUR;
    const { h } = await openIncompleteScan(NOW - 11_000, incompleteFrom);
    const info = spyInfo();
    const warn = spyWarn();
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [CHAT_P2P],
      chatModeErrors: { [CHAT_P2P]: httpStatusError(429) },
    }));
    expect(events(warn, 'backfill')).toContainEqual(
      expect.objectContaining({
        event: 'mode-resolve-failed',
        chatId: CHAT_P2P,
        status: 429,
      }),
    );
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({
        event: 'incomplete',
        modeLookupFailures: 1,
        fetchFailures: 0,
        enqueuedTotal: 1,
      }),
    );
    expect(h.ledger.getIncompleteFrom()).toBe(incompleteFrom);
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
  });

  it('keeps the incomplete scan when session p2p mode lookup returns HTTP 408', async () => {
    const incompleteFrom = NOW - 6 * HOUR;
    const { h } = await openIncompleteScan(NOW - 11_000, incompleteFrom);
    const info = spyInfo();
    const warn = spyWarn();
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [CHAT_P2P],
      chatModeErrors: { [CHAT_P2P]: httpStatusError(408) },
    }));
    expect(events(warn, 'backfill')).toContainEqual(
      expect.objectContaining({
        event: 'mode-resolve-failed',
        chatId: CHAT_P2P,
        status: 408,
      }),
    );
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({
        event: 'incomplete',
        modeLookupFailures: 1,
        fetchFailures: 0,
        enqueuedTotal: 1,
      }),
    );
    expect(h.ledger.getIncompleteFrom()).toBe(incompleteFrom);
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
  });

  it('keeps the incomplete scan when session p2p mode lookup fails on the network', async () => {
    const incompleteFrom = NOW - 6 * HOUR;
    const { h } = await openIncompleteScan(NOW - 11_000, incompleteFrom);
    const info = spyInfo();
    const warn = spyWarn();
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [CHAT_P2P],
      chatModeErrors: {
        [CHAT_P2P]: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      },
    }));
    const modeWarn = events(warn, 'backfill').find((row) => row.event === 'mode-resolve-failed');
    expect(modeWarn).toMatchObject({ chatId: CHAT_P2P });
    expect(modeWarn).not.toHaveProperty('status');
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({
        event: 'incomplete',
        modeLookupFailures: 1,
        enqueuedTotal: 1,
      }),
    );
    expect(h.ledger.getIncompleteFrom()).toBe(incompleteFrom);
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
  });

  it('keeps the incomplete scan when mode lookup error.code is 400 but HTTP status is absent', async () => {
    const incompleteFrom = NOW - 6 * HOUR;
    const { h } = await openIncompleteScan(NOW - 11_000, incompleteFrom);
    const info = spyInfo();
    const warn = spyWarn();
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [CHAT_P2P],
      chatModeErrors: {
        [CHAT_P2P]: Object.assign(new Error('ERR_BAD_REQUEST'), { code: 400 }),
      },
    }));
    const modeWarn = events(warn, 'backfill').find((row) => row.event === 'mode-resolve-failed');
    expect(modeWarn).toMatchObject({ chatId: CHAT_P2P });
    expect(modeWarn).not.toHaveProperty('status');
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'incomplete', modeLookupFailures: 1 }),
    );
    expect(h.ledger.getIncompleteFrom()).toBe(incompleteFrom);
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
  });

  it('completes the window when one chat history fetch returns HTTP 400', async () => {
    const lastLiveAt = NOW - 5 * 60_000;
    const h = await harness({
      lastLiveAt,
      chats: [
        { id: CHAT_A, name: 'A' },
        { id: CHAT_B, name: 'B' },
      ],
      messages: {
        [CHAT_A]: [mentionItem('om_a', CHAT_A, 'from a', NOW - 20_000)],
        [CHAT_B]: [mentionItem('om_b', CHAT_B, 'from b', NOW - 15_000)],
      },
      listErrors: { [CHAT_B]: httpStatusError(400) },
    });
    const info = spyInfo();
    const warn = spyWarn();
    await runBackfill(await deps(h));

    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_a']);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'done', chats: 2, enqueuedTotal: 1 }),
    );
    expect(events(info, 'backfill').filter((row) => row.event === 'incomplete')).toEqual([]);
    expect(events(warn, 'backfill')).toContainEqual(
      expect.objectContaining({
        event: 'chat-fetch-failed',
        chatId: CHAT_B,
        status: 400,
        code: 'ERR_BAD_REQUEST',
      }),
    );
    expect(h.ledger.getIncompleteFrom()).toBeUndefined();
    expect(h.ledger.getLastBackfillEnd()).toBe(NOW);
    expect(h.ledger.getLiveAt()).toBe(lastLiveAt);
  });

  it('keeps the scan incomplete when one chat history fetch returns HTTP 500', async () => {
    const lastLiveAt = NOW - 5 * 60_000;
    const h = await harness({
      lastLiveAt,
      chats: [
        { id: CHAT_A, name: 'A' },
        { id: CHAT_B, name: 'B' },
      ],
      messages: {
        [CHAT_A]: [mentionItem('om_a', CHAT_A, 'from a', NOW - 20_000)],
        [CHAT_B]: [mentionItem('om_b', CHAT_B, 'from b', NOW - 15_000)],
      },
      listErrors: { [CHAT_B]: httpStatusError(500) },
    });
    const info = spyInfo();
    const warn = spyWarn();
    await runBackfill(await deps(h));

    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_a']);
    expect(events(warn, 'backfill')).toContainEqual(
      expect.objectContaining({
        event: 'chat-fetch-failed',
        chatId: CHAT_B,
        status: 500,
      }),
    );
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'incomplete', chats: 2, enqueuedTotal: 1, fetchFailures: 1 }),
    );
    expect(events(info, 'backfill').filter((row) => row.event === 'done')).toEqual([]);
    expect(h.ledger.getIncompleteFrom()).toBe(lastLiveAt);
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
  });

  it('keeps the scan incomplete when one chat history fetch returns HTTP 429', async () => {
    const lastLiveAt = NOW - 5 * 60_000;
    const h = await harness({
      lastLiveAt,
      chats: [
        { id: CHAT_A, name: 'A' },
        { id: CHAT_B, name: 'B' },
      ],
      messages: {
        [CHAT_A]: [mentionItem('om_a', CHAT_A, 'from a', NOW - 20_000)],
      },
      listErrors: { [CHAT_B]: httpStatusError(429) },
    });
    const info = spyInfo();
    const warn = spyWarn();
    await runBackfill(await deps(h));

    expect(events(warn, 'backfill')).toContainEqual(
      expect.objectContaining({
        event: 'chat-fetch-failed',
        chatId: CHAT_B,
        status: 429,
      }),
    );
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'incomplete', fetchFailures: 1, enqueuedTotal: 1 }),
    );
    expect(h.ledger.getIncompleteFrom()).toBe(lastLiveAt);
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
  });

  it('keeps the scan incomplete when one chat history fetch returns HTTP 408', async () => {
    const lastLiveAt = NOW - 5 * 60_000;
    const h = await harness({
      lastLiveAt,
      chats: [
        { id: CHAT_A, name: 'A' },
        { id: CHAT_B, name: 'B' },
      ],
      messages: {
        [CHAT_A]: [mentionItem('om_a', CHAT_A, 'from a', NOW - 20_000)],
      },
      listErrors: { [CHAT_B]: httpStatusError(408) },
    });
    const info = spyInfo();
    const warn = spyWarn();
    await runBackfill(await deps(h));

    expect(events(warn, 'backfill')).toContainEqual(
      expect.objectContaining({
        event: 'chat-fetch-failed',
        chatId: CHAT_B,
        status: 408,
      }),
    );
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'incomplete', fetchFailures: 1, enqueuedTotal: 1 }),
    );
    expect(h.ledger.getIncompleteFrom()).toBe(lastLiveAt);
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
  });

  it('keeps the scan incomplete when a chat history fetch has error.code 400 and no HTTP status', async () => {
    const lastLiveAt = NOW - 5 * 60_000;
    const h = await harness({
      lastLiveAt,
      chats: [{ id: CHAT_A, name: 'A' }, { id: CHAT_B, name: 'B' }],
      messages: {
        [CHAT_A]: [mentionItem('om_a', CHAT_A, 'from a', NOW - 20_000)],
      },
      listErrors: {
        [CHAT_B]: Object.assign(new Error('bad request'), { code: 400 }),
      },
    });
    const info = spyInfo();
    const warn = spyWarn();
    await runBackfill(await deps(h));

    const fetchWarn = events(warn, 'backfill').find((row) => row.event === 'chat-fetch-failed');
    expect(fetchWarn).toMatchObject({ chatId: CHAT_B, code: 400 });
    expect(fetchWarn).not.toHaveProperty('status');
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'incomplete', fetchFailures: 1 }),
    );
    expect(h.ledger.getIncompleteFrom()).toBe(lastLiveAt);
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
  });

  it('deduplicates session scopes and bounds unique mode lookups to maxChats, unlisted first', async () => {
    const extras = Array.from({ length: 4 }, (_, i) => `oc_extra_${i}`);
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: {
        [CHAT_A]: [mentionItem('om_a', CHAT_A, 'a', NOW - 10_000, { threadId: 'omt_a' })],
        [CHAT_P2P]: [humanItem('om_dm', CHAT_P2P, '在？', NOW - 10_000)],
      },
    });
    const modeLookups: string[] = [];
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [
        CHAT_A,
        `${CHAT_A}:thread`,
        CHAT_P2P,
        CHAT_P2P,
        `${CHAT_P2P}:topic`,
        ...extras,
      ],
      chatModes: { [CHAT_P2P]: 'p2p' },
      modeLookups,
      prefs: { ...DEFAULT_BACKFILL_PREFERENCES, maxChats: 2 },
    }));
    expect(modeLookups.slice().sort()).toEqual([CHAT_P2P, 'oc_extra_0'].sort());
    expect(h.list).toEqual([CHAT_A, CHAT_P2P]);
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_a', 'om_dm']);
  });

  it('does not query chat mode for auto: or meeting: catalog scopes and completes the scan', async () => {
    const lastLiveAt = NOW - 5 * 60_000;
    const h = await harness({
      lastLiveAt,
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: {
        [CHAT_A]: [mentionItem('om_a', CHAT_A, 'from a', NOW - 10_000, { threadId: 'omt_a' })],
      },
    });
    const modeLookups: string[] = [];
    const info = spyInfo();
    const warn = spyWarn();
    await runBackfill(await deps({
      ...h,
      sessionChatIds: ['auto:3:oc_chat_a', 'meeting:70001'],
      modeLookups,
      chatModeErrors: {
        auto: new Error('auto is not a chat'),
        meeting: new Error('meeting is not a chat'),
      },
    }));
    expect(modeLookups).toEqual([]);
    expect(events(warn, 'backfill').filter((row) => row.event === 'mode-resolve-failed')).toEqual([]);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'done', enqueuedTotal: 1 }),
    );
    expect(events(info, 'backfill').filter((row) => row.event === 'incomplete')).toEqual([]);
    expect(h.ledger.getIncompleteFrom()).toBeUndefined();
    expect(h.ledger.getLastBackfillEnd()).toBe(NOW);
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_a']);
  });

  it('classifies unique session chats concurrently', async () => {
    const chats = ['oc_p2p_a', 'oc_p2p_b', 'oc_p2p_c', 'oc_p2p_d'];
    const h = await harness({ chats: [], messages: {} });
    let inFlight = 0;
    let peak = 0;
    await runBackfill(await deps({
      ...h,
      sessionChatIds: chats,
      chatModes: Object.fromEntries(chats.map((id) => [id, 'p2p' as const])),
      onGetChatMode: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 25));
        inFlight -= 1;
      },
    }));
    expect(peak).toBeGreaterThan(1);
  });

  it('scans session-known p2p in personal mode without a chat allowlist', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: {
        [CHAT_A]: [mentionItem('om_group', CHAT_A, 'from group', NOW - 20_000)],
        [CHAT_P2P]: [humanItem('om_dm', CHAT_P2P, '在？', NOW - 10_000)],
      },
    });
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [CHAT_P2P],
      chatModes: { [CHAT_P2P]: 'p2p' },
      profile: { mode: 'personal', access: { allowedChats: [] } },
    }));
    expect(h.list).toEqual([CHAT_P2P]);
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_dm']);
    expect(h.intake[0]?.chatType).toBe('p2p');
  });

  it('marks a p2p chat-fetch failure incomplete without advancing lastBackfillEnd', async () => {
    const lastLiveAt = NOW - 5 * 60_000;
    const h = await harness({
      lastLiveAt,
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: [mentionItem('om_group', CHAT_A, 'from group', NOW - 10_000)] },
      listErrors: { [CHAT_P2P]: Object.assign(new Error('dm denied'), { code: 99991663 }) },
    });
    const info = spyInfo();
    const warn = spyWarn();
    await runBackfill(await deps({
      ...h,
      sessionChatIds: [CHAT_P2P],
      chatModes: { [CHAT_P2P]: 'p2p' },
    }));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_group']);
    expect(events(warn, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'chat-fetch-failed', chatId: CHAT_P2P, code: 99991663 }),
    );
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'incomplete', fetchFailures: 1, enqueuedTotal: 1 }),
    );
    expect(h.ledger.getLastBackfillEnd()).toBeUndefined();
    expect(h.ledger.getIncompleteFrom()).toBe(lastLiveAt);
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
      since: lastLiveAt,
      lookbackMs: DEFAULT_BACKFILL_PREFERENCES.lookbackMs,
    });
    expect(h.requests[0]).toEqual({
      container_id_type: 'chat',
      container_id: CHAT_A,
      start_time: String(Math.floor(window.windowStart / 1000)),
      end_time: String(Math.ceil(window.windowEnd / 1000)),
      sort_type: 'ByCreateTimeDesc',
      page_size: 50,
    });
  });
});

describe('runBackfill delay line', () => {
  it('posts one fixed delay line per non-empty batch before dispatch, none for an empty batch', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }, { id: CHAT_B, name: 'B' }],
      messages: {
        [CHAT_A]: [
          mentionItem('om_a1', CHAT_A, 'first', NOW - 20_000),
          mentionItem('om_a2', CHAT_A, 'second', NOW - 10_000),
        ],
        [CHAT_B]: [chatterItem('om_b1', CHAT_B, NOW - 15_000)],
      },
    });
    const order: string[] = [];
    await runBackfill(await deps({
      ...h,
      onIntake: (msg) => order.push(`intake:${msg.messageId}`),
      postDelayLine: async (target, text) => {
        order.push(`delay:${target.chatId}:${target.messageId}:${text}`);
      },
    }));
    expect(BACKFILL_DELAY_LINE).toBe('bot 刚恢复在线，正在补回复离线期间收到的消息。');
    expect(order).toEqual([
      `delay:${CHAT_A}:om_a1:${BACKFILL_DELAY_LINE}`,
      'intake:om_a1',
      'intake:om_a2',
    ]);
  });

  it('posts one delay line per topic thread, since each thread is its own batch', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: {
        [CHAT_A]: [
          mentionItem('om_t1a', CHAT_A, 'first', NOW - 30_000, { threadId: 'omt_1' }),
          mentionItem('om_t2a', CHAT_A, 'second', NOW - 20_000, { threadId: 'omt_2' }),
          mentionItem('om_t1b', CHAT_A, 'third', NOW - 10_000, { threadId: 'omt_1' }),
        ],
      },
    });
    const posted: string[] = [];
    await runBackfill(await deps({
      ...h,
      postDelayLine: async (target) => {
        posted.push(target.messageId);
      },
    }));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_t1a', 'om_t2a', 'om_t1b']);
    expect(posted).toEqual(['om_t1a', 'om_t2a']);
  });

  it('still dispatches the batch when posting the delay line fails', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: [mentionItem('om_a1', CHAT_A, 'first', NOW - 10_000)] },
    });
    const warn = spyWarn();
    const ok = await runBackfill(await deps({
      ...h,
      postDelayLine: async () => {
        throw new Error('send failed');
      },
    }));
    expect(ok).toBe(true);
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_a1']);
    expect(events(warn, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'delay-line-failed', chatId: CHAT_A, msgId: 'om_a1' }),
    );
  });

  it('retries the delay line on the next message after a failed post and records which messages it announced', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: {
        [CHAT_A]: [
          mentionItem('om_a1', CHAT_A, 'first', NOW - 30_000),
          mentionItem('om_a2', CHAT_A, 'second', NOW - 20_000),
          mentionItem('om_a3', CHAT_A, 'third', NOW - 10_000),
        ],
      },
    });
    const marks: RunBackfillDeps['marks'] = new Map();
    const attempts: string[] = [];
    await runBackfill(await deps({
      ...h,
      marks,
      postDelayLine: async (target) => {
        attempts.push(target.messageId);
        if (target.messageId === 'om_a1') throw new Error('send failed');
      },
    }));
    expect(attempts).toEqual(['om_a1', 'om_a2']);
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_a1', 'om_a2', 'om_a3']);
    expect([...marks].map(([id, mark]) => [id, mark.delayAnnounced])).toEqual([
      ['om_a1', false],
      ['om_a2', true],
      ['om_a3', true],
    ]);
  });

  it('retries the delay line on a re-scan when the earlier scan failed to post it', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: [mentionItem('om_a1', CHAT_A, 'first', NOW - 10_000)] },
    });
    const marks: RunBackfillDeps['marks'] = new Map();
    const attempts: string[] = [];
    let fail = true;
    const postDelayLine = async (target: NormalizedMessage) => {
      attempts.push(target.messageId);
      if (fail) throw new Error('send failed');
    };
    await runBackfill(await deps({ ...h, marks, postDelayLine }));
    h.ledger.unrecord('om_a1');
    fail = false;
    await runBackfill(await deps({ ...h, marks, postDelayLine }));
    expect(attempts).toEqual(['om_a1', 'om_a1']);
    expect(marks.get('om_a1')?.delayAnnounced).toBe(true);
  });

  it('posts no second delay line when a re-scan finds only messages an earlier scan already enqueued', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: [mentionItem('om_a1', CHAT_A, 'first', NOW - 10_000)] },
    });
    const marks: RunBackfillDeps['marks'] = new Map();
    const posted: string[] = [];
    const postDelayLine = async (target: NormalizedMessage) => {
      posted.push(target.messageId);
    };
    await runBackfill(await deps({ ...h, marks, postDelayLine }));
    h.ledger.unrecord('om_a1');
    await runBackfill(await deps({ ...h, marks, postDelayLine }));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_a1', 'om_a1']);
    expect(posted).toEqual(['om_a1']);
  });

  it('posts no delay line in dryRun', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: [mentionItem('om_a1', CHAT_A, 'first', NOW - 10_000)] },
    });
    const posted: string[] = [];
    await runBackfill(await deps({
      ...h,
      prefs: { ...DEFAULT_BACKFILL_PREFERENCES, dryRun: true },
      postDelayLine: async (target) => {
        posted.push(target.messageId);
      },
    }));
    expect(posted).toEqual([]);
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
    const firstDeps = await deps({ ...h, listChatsHold: hold });
    const secondDeps = await deps({ ...h, listChatsHold: hold });
    const info = spyInfo();
    const first = run(firstDeps);
    const second = run(secondDeps);
    expect(second).toBe(first);
    await waitUntil(() => h.listed.length >= 1);
    expect(h.listed).toHaveLength(1);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'coalesced' }),
    );
    release();
    await first;
    expect(h.listed).toHaveLength(1);
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_1']);
  });

  it('coalesced scans do not start a second list while one is in flight', async () => {
    let releaseList: () => void = () => {};
    const listHold = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: [mentionItem('om_connect', CHAT_A, 'first', NOW - 10_000)] },
    });
    const run = createBackfillRun();
    const info = spyInfo();
    const first = run(await deps({
      ...h,
      listChatsHold: listHold,
    }));
    const second = run(await deps(h));
    expect(second).toBe(first);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'coalesced' }),
    );
    releaseList();
    await first;
    expect(h.listed).toHaveLength(1);
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_connect']);
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
    const next = await deps({ ...h, now: () => now });
    await run(next);
    expect(h.listed).toHaveLength(2);
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'trigger' }),
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
    await waitUntil(() => leftH.listed.length >= 1 && rightH.listed.length >= 1);
    expect(leftH.listed).toHaveLength(1);
    expect(rightH.listed).toHaveLength(1);
    expect(events(info, 'backfill').filter((row) => row.event === 'coalesced')).toEqual([]);
    release();
    await Promise.all([first, second]);
  });
});

describe('backfill sender type for automation', () => {
  it('keeps sender_type=user on a backfilled mention so automation is available', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: [mentionItem('om_human', CHAT_A, '列出本群自动化', NOW - 10_000)] },
    });
    await runBackfill(await deps(h));
    expect(h.intake).toHaveLength(1);
    const msg = h.intake[0]!;
    expect(senderTypeFromRaw(msg.raw)).toBe('user');
    expect(automationUnavailableForSender(msg)).toBeUndefined();
  });

  it('keeps sender_type=app on a backfilled other-app mention so automation requires a human', async () => {
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: {
        [CHAT_A]: [
          mentionItem('om_app', CHAT_A, '列出本群自动化', NOW - 20_000, {
            senderId: OTHER_APP,
            senderType: 'app',
          }),
          mentionItem('om_self', CHAT_A, '列出本群自动化', NOW - 10_000, {
            senderId: APP_ID,
            senderType: 'app',
          }),
        ],
      },
    });
    await runBackfill(await deps({ ...h, botAppId: APP_ID }));
    expect(h.intake.map((msg) => msg.messageId)).toEqual(['om_app']);
    const msg = h.intake[0]!;
    expect(senderTypeFromRaw(msg.raw)).toBe('app');
    expect(automationUnavailableForSender(msg)).toBe('automation-requires-human');
  });

  it('does not label a backfilled mention with missing sender_type as automation-requires-human', async () => {
    const item = mentionItem('om_unknown', CHAT_A, '列出本群自动化', NOW - 10_000);
    const sender = item.sender as Record<string, unknown>;
    delete sender.sender_type;
    const h = await harness({
      chats: [{ id: CHAT_A, name: 'A' }],
      messages: { [CHAT_A]: [item] },
    });
    const info = spyInfo();
    await runBackfill(await deps(h));
    expect(h.intake).toHaveLength(1);
    const msg = h.intake[0]!;
    expect(senderTypeFromRaw(msg.raw)).toBeUndefined();
    expect(automationUnavailableForSender(msg)).toBe('automation-sender-type-missing');
    expect(events(info, 'backfill')).toContainEqual(
      expect.objectContaining({ event: 'sender-type-missing', msgId: 'om_unknown' }),
    );
  });
});

describe('formatBackfillLatenessHint', () => {
  const HOST_TZ = 'America/New_York';
  const PROFILE_TZ = 'Europe/Berlin';
  let previousTz: string | undefined;

  beforeEach(() => {
    previousTz = process.env.TZ;
    process.env.TZ = HOST_TZ;
  });

  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  it('formats a same-day send time in the profile time zone, not the host one', () => {
    const createTimeMs = Date.UTC(2026, 8, 11, 4, 7, 0);
    expect(formatBackfillLatenessHint({
      createTimeMs,
      nowMs: createTimeMs + 12 * 60_000,
      timeZone: PROFILE_TZ,
      delayAnnounced: true,
    })).toBe(
      '以下用户消息发于 06:07（约 12 分钟前），bot 离线期间未处理；消息中的相对时间按发送时刻理解。' +
        'bridge 已自行告知延迟，直接回答用户请求。',
    );
  });

  it('includes the date when the send time falls on an earlier profile-local day', () => {
    const createTimeMs = Date.UTC(2026, 8, 10, 21, 50, 0);
    expect(formatBackfillLatenessHint({
      createTimeMs,
      nowMs: createTimeMs + 30 * 60_000,
      timeZone: PROFILE_TZ,
      delayAnnounced: true,
    })).toBe(
      '以下用户消息发于 2026-09-10 23:50（约 30 分钟前），bot 离线期间未处理；消息中的相对时间按发送时刻理解。' +
        'bridge 已自行告知延迟，直接回答用户请求。',
    );
  });

  it('asks the model to acknowledge the late reply itself when the bridge could not announce the delay', () => {
    const createTimeMs = Date.UTC(2026, 8, 11, 4, 7, 0);
    expect(formatBackfillLatenessHint({
      createTimeMs,
      nowMs: createTimeMs + 12 * 60_000,
      timeZone: PROFILE_TZ,
      delayAnnounced: false,
    })).toBe(
      '以下用户消息发于 06:07（约 12 分钟前），bot 离线期间未处理；消息中的相对时间按发送时刻理解。' +
        '回复开头先用一句话简短说明这是 bot 离线期间收到、较晚补上的回复，再回答用户请求。',
    );
  });
});

function httpStatusError(status: number, message = `status ${status}`): Error {
  return Object.assign(new Error(message), {
    code: 'ERR_BAD_REQUEST',
    response: { status, data: { code: 99991663 } },
  });
}

async function openIncompleteScan(lastLiveAt: number, incompleteFrom: number) {
  const h = await harness({
    lastLiveAt,
    chats: [{ id: CHAT_A, name: 'A' }],
    messages: {
      [CHAT_A]: [mentionItem('om_group', CHAT_A, 'from group', NOW - 20_000)],
    },
  });
  h.ledger.markScanIncomplete(incompleteFrom);
  return { h };
}

async function harness(opts: {
  lastLiveAt?: number | undefined;
  chats?: Array<{ id: string; name: string }>;
  messages?: Record<string, Record<string, unknown>[]>;
  listErrors?: Record<string, Error>;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'backfill-'));
  dirs.push(dir);
  const ledger = new BackfillLedger(join(dir, 'backfill-state.json'), { now: () => NOW });
  ledgers.push(ledger);
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
  botAppId?: string;
  fromMs?: number;
  since?: number;
  now?: () => number;
  refreshKnownChats?: (chats: Array<{ id: string; name: string }>) => void;
  isClosing?: () => boolean;
  onIntake?: (msg: NormalizedMessage) => void;
  postDelayLine?: RunBackfillDeps['postDelayLine'];
  marks?: RunBackfillDeps['marks'];
  sessionChatIds?: string[];
  chatModes?: Record<string, 'p2p' | 'group' | 'topic'>;
  chatModeErrors?: Record<string, Error>;
  modeLookups?: string[];
  onGetChatMode?: (chatId: string) => Promise<void>;
  requireMentionForChat?: (chatId: string) => boolean;
  listMessagesHold?: Promise<void>;
  onListMessages?: (chatId: string) => Promise<void>;
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
    chatModes: input.chatModes,
    chatModeErrors: input.chatModeErrors,
    modeLookups: input.modeLookups,
    onGetChatMode: input.onGetChatMode,
    listMessagesHold: input.listMessagesHold,
    onListMessages: input.onListMessages,
  });
  const marks: RunBackfillDeps['marks'] = input.marks ?? new Map();
  const now = input.now ?? (() => NOW);
  const since = input.since ?? input.ledger.getLiveAt() ?? now();
  const fromMs = input.fromMs ?? resolveBackfillWindow({
    now: now(),
    since,
    incompleteFrom: input.ledger.getIncompleteFrom(),
    lookbackMs: (input.prefs ?? DEFAULT_BACKFILL_PREFERENCES).lookbackMs,
  }).windowStart;
  return {
    fromMs,
    since,
    channel,
    ledger: input.ledger,
    prefs: input.prefs ?? DEFAULT_BACKFILL_PREFERENCES,
    profile: input.profile ?? { mode: 'team', access: { allowedChats: [] } },
    now,
    marks,
    isClosing: input.isClosing ?? (() => false),
    refreshKnownChats: input.refreshKnownChats,
    sessionChatIds: input.sessionChatIds,
    ...(input.botAppId !== undefined ? { botAppId: input.botAppId } : {}),
    ...(input.requireMentionForChat ? { requireMentionForChat: input.requireMentionForChat } : {}),
    ...(input.postDelayLine ? { postDelayLine: input.postDelayLine } : {}),
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
  chatModes?: Record<string, 'p2p' | 'group' | 'topic'>;
  chatModeErrors?: Record<string, Error>;
  modeLookups?: string[];
  onGetChatMode?: (chatId: string) => Promise<void>;
  listMessagesHold?: Promise<void>;
  onListMessages?: (chatId: string) => Promise<void>;
}): BackfillChannel {
  return {
    botIdentity: opts.identity,
    async listChats(query) {
      opts.listed.push(query ?? {});
      if (opts.listChatsHold) await opts.listChatsHold;
      if (opts.listChatsError) throw opts.listChatsError;
      return opts.chats;
    },
    async getChatMode(chatId) {
      opts.modeLookups?.push(chatId);
      await opts.onGetChatMode?.(chatId);
      const error = opts.chatModeErrors?.[chatId];
      if (error) throw error;
      return opts.chatModes?.[chatId] ?? 'group';
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
              const items = [...(opts.messages[chatId] ?? [])];
              await opts.onListMessages?.(chatId);
              if (opts.listMessagesHold) await opts.listMessagesHold;
              if (params.sort_type === 'ByCreateTimeDesc') items.reverse();
              const chatPages = chunk(items, 50);
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

function humanItem(
  messageId: string,
  chatId: string,
  text: string,
  createTime: number,
  extra: { senderId?: string; senderType?: string } = {},
): Record<string, unknown> {
  return {
    message_id: messageId,
    chat_id: chatId,
    msg_type: 'text',
    create_time: String(createTime),
    deleted: false,
    sender: {
      id: extra.senderId ?? USER,
      id_type: 'open_id',
      sender_type: extra.senderType ?? 'user',
    },
    body: { content: JSON.stringify({ text }) },
    mentions: [],
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

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for backfill condition');
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
