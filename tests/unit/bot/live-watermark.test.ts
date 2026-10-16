import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import { runBackfill, WATERMARK_MARGIN_MS, type BackfillChannel } from '../../../src/bot/backfill';
import { BackfillLedger } from '../../../src/bot/backfill-ledger';
import {
  FEISHU_LINK_SILENT_PROBE_MS,
  FEISHU_LINK_TICK_MS,
  startFeishuLink,
  type Outage,
} from '../../../src/bot/feishu-link';
import { createRecovery } from '../../../src/bot/recovery';
import { DEFAULT_BACKFILL_PREFERENCES } from '../../../src/config/schema';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';

const dirs: string[] = [];
const links: Array<{ stop(): void }> = [];

afterEach(async () => {
  for (const link of links.splice(0)) link.stop();
  await Promise.all(dirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
  ));
});

describe('FeishuLink live watermark', () => {
  it('writes lastLiveAt only on evidence, not on connected ticks', async () => {
    let now = 1_700_000_000_000;
    let state: 'connected' | 'reconnecting' | 'failed' = 'connected';
    const dir = await mkdtemp(join(tmpdir(), 'live-watermark-'));
    dirs.push(dir);
    const file = join(dir, 'backfill-state.json');
    const ledger = new BackfillLedger(file, { now: () => now });
    await ledger.load();

    const link = start({
      now: () => now,
      state: () => state,
      watermark: ledger,
    });

    await link.tick();
    await ledger.flush();
    expect(JSON.parse(await readFile(file, 'utf8')).lastLiveAt).toBe(now);

    now += FEISHU_LINK_TICK_MS;
    await link.tick();
    await ledger.flush();
    expect(ledger.getLiveAt()).toBe(now - FEISHU_LINK_TICK_MS);

    const frozen = ledger.getLiveAt();
    state = 'reconnecting';
    now += FEISHU_LINK_TICK_MS;
    await link.tick();
    expect(ledger.getLiveAt()).toBe(frozen);

    state = 'failed';
    now += FEISHU_LINK_TICK_MS;
    await link.tick();
    expect(ledger.getLiveAt()).toBe(frozen);

    state = 'connected';
    now += FEISHU_LINK_SILENT_PROBE_MS;
    await link.tick();
    await ledger.flush();
    expect(JSON.parse(await readFile(file, 'utf8')).lastLiveAt).toBe(now);
  });

  it('scans the sleep gap on wake-up before a later connected tick can close it', async () => {
    let now = 1_700_000_000_000;
    const dir = await mkdtemp(join(tmpdir(), 'wake-up-backfill-'));
    dirs.push(dir);
    const ledger = new BackfillLedger(join(dir, 'backfill-state.json'), { now: () => now });
    await ledger.load();
    const channel = createRecordingLarkChannel({
      botIdentity: { openId: 'ou_bot', name: 'Bot' },
      chats: [{ id: 'oc_group', name: 'Group' }],
      messagesByChat: {
        oc_group: [mentionItem('om_slept', 'oc_group', 'missed while asleep', now + 2 * 60_000)],
      },
    });
    const intake: string[] = [];
    const recovery = createRecovery({
      journal: {
        reapOrphans: async () => {},
        redeliver: async () => {},
      },
      backfill: {
        scan: async (fromMs) => {
          await runBackfill({
            fromMs,
            channel: channel as unknown as BackfillChannel,
            ledger,
            prefs: DEFAULT_BACKFILL_PREFERENCES,
            profile: { mode: 'team', access: { allowedChats: [] } },
            now: () => now,
            marks: new Map(),
            intake: async (msg) => {
              if (!ledger.claim(msg.messageId)) return;
              ledger.record(msg.messageId, msg.createTime);
              intake.push(msg.messageId);
            },
          });
        },
      },
      runs: { review: () => {} },
      lookbackMs: () => DEFAULT_BACKFILL_PREFERENCES.lookbackMs,
      now: () => now,
    });

    const recovered: Outage[] = [];
    let pending: Promise<void> | undefined;
    const link = start({
      now: () => now,
      state: () => 'connected',
      watermark: ledger,
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
      pending = recovery.run(outage);
    });

    const originMs = now;
    await link.tick();
    await pending;
    expect(ledger.getLiveAt()).toBe(originMs);
    recovered.length = 0;

    now += 5 * 60_000;
    await link.tick();
    await pending;
    await waitFor(() => intake.includes('om_slept'));
    expect(intake).toEqual(['om_slept']);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.since).toBeLessThanOrEqual(now - 5 * 60_000);
    expect(recovered[0]!.since).toBeGreaterThanOrEqual(now - 5 * 60_000 - WATERMARK_MARGIN_MS);
  });
});

function start(opts: {
  now: () => number;
  state: () => 'connected' | 'reconnecting' | 'failed' | undefined;
  watermark: BackfillLedger;
}) {
  const handle = startFeishuLink({
    channel: {
      getConnectionStatus: () => {
        const state = opts.state();
        return state ? { state, reconnectAttempts: 0 } : undefined;
      },
    } as unknown as LarkChannel,
    probe: async () => true,
    watermark: {
      get: () => opts.watermark.getLiveAt(),
      set: (at) => opts.watermark.touchLive(at),
    },
    now: opts.now,
  });
  links.push(handle);
  return handle;
}

function mentionItem(
  messageId: string,
  chatId: string,
  text: string,
  createTime: number,
): Record<string, unknown> {
  return {
    message_id: messageId,
    chat_id: chatId,
    msg_type: 'text',
    create_time: String(createTime),
    deleted: false,
    sender: { id: 'ou_user', id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: `@_user_1 ${text}` }) },
    mentions: [{ key: '@_user_1', id: 'ou_bot', id_type: 'open_id', name: 'Bot' }],
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let n = 0; n < 10_000; n++) {
    if (predicate()) return;
    await yieldIO();
  }
  throw new Error('expected wake-up backfill transition was not observed');
}
