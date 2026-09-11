import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBackfill, type BackfillChannel } from '../../../src/bot/backfill';
import { BackfillLedger, LIVE_WATERMARK_THROTTLE_MS } from '../../../src/bot/backfill-ledger';
import { startKeepalive, type KeepaliveHandle } from '../../../src/bot/keepalive';
import { DEFAULT_BACKFILL_PREFERENCES } from '../../../src/config/schema';
import { createRecordingLarkChannel } from '../../helpers/recording-lark-channel';

const dirs: string[] = [];
const handles: KeepaliveHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
  ));
});

describe('keepalive live-watermark hook', () => {
  it('invokes onConnectedTick only while the WS is connected', async () => {
    const ticks: number[] = [];
    let now = 1_700_000_000_000;
    let state: 'connected' | 'reconnecting' | 'failed' | undefined = 'connected';
    const keepalive = start({
      now: () => now,
      state: () => state,
      onConnectedTick: (at) => ticks.push(at),
    });

    await keepalive.tick();
    expect(ticks).toEqual([now]);

    now += 15_000;
    state = 'reconnecting';
    await keepalive.tick();
    expect(ticks).toEqual([1_700_000_000_000]);

    now += 15_000;
    state = 'failed';
    await keepalive.tick();
    expect(ticks).toEqual([1_700_000_000_000]);

    now += 15_000;
    state = undefined;
    await keepalive.tick();
    expect(ticks).toEqual([1_700_000_000_000]);

    now += 15_000;
    state = 'connected';
    await keepalive.tick();
    expect(ticks).toEqual([1_700_000_000_000, now]);
  });

  it('does not invoke onConnectedTick on storm-guard or wake-up early returns', async () => {
    const onConnectedTick = vi.fn();
    const onWakeUp = vi.fn();
    let now = 1_700_000_000_000;
    const keepalive = start({
      now: () => now,
      state: () => 'connected',
      onConnectedTick,
      onWakeUp,
    });

    await keepalive.tick();
    expect(onConnectedTick).toHaveBeenCalledTimes(1);
    expect(onWakeUp).not.toHaveBeenCalled();

    now += 1_000;
    await keepalive.tick();
    expect(onConnectedTick).toHaveBeenCalledTimes(1);
    expect(onWakeUp).not.toHaveBeenCalled();

    now += 31_000;
    await keepalive.tick();
    expect(onConnectedTick).toHaveBeenCalledTimes(1);
    expect(onWakeUp).toHaveBeenCalledTimes(1);

    now += 15_000;
    await keepalive.tick();
    expect(onConnectedTick).toHaveBeenCalledTimes(2);
    expect(onWakeUp).toHaveBeenCalledTimes(1);
  });
});

describe('connected keepalive ticks through the ledger', () => {
  it('advances lastLiveAt at most every 30s and ignores disconnected or stuck ticks', async () => {
    let now = 1_700_000_000_000;
    let state: 'connected' | 'reconnecting' | 'failed' = 'connected';
    const dir = await mkdtemp(join(tmpdir(), 'live-watermark-'));
    dirs.push(dir);
    const file = join(dir, 'backfill-state.json');
    const ledger = new BackfillLedger(file, { now: () => now });
    await ledger.load();

    const keepalive = start({
      now: () => now,
      state: () => state,
      onConnectedTick: (at) => ledger.touchLive(at),
    });

    await keepalive.tick();
    await ledger.flush();
    const persisted = JSON.parse(await readFile(file, 'utf8')).lastLiveAt as number;
    expect(persisted).toBe(now);

    now += 15_000;
    await keepalive.tick();
    await ledger.flush();
    expect(ledger.getLiveAt()).toBe(now);
    expect(JSON.parse(await readFile(file, 'utf8')).lastLiveAt).toBe(persisted);

    const frozen = ledger.getLiveAt();
    state = 'reconnecting';
    now += LIVE_WATERMARK_THROTTLE_MS;
    await keepalive.tick();
    await ledger.flush();
    expect(ledger.getLiveAt()).toBe(frozen);
    expect(JSON.parse(await readFile(file, 'utf8')).lastLiveAt).toBe(persisted);

    state = 'failed';
    now += LIVE_WATERMARK_THROTTLE_MS;
    await keepalive.tick();
    await ledger.flush();
    expect(ledger.getLiveAt()).toBe(frozen);

    state = 'connected';
    await keepalive.tick();
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
    const launchBackfill = (): void => {
      void runBackfill({
        trigger: 'wake-up',
        channel: channel as unknown as BackfillChannel,
        ledger,
        prefs: DEFAULT_BACKFILL_PREFERENCES,
        profile: { mode: 'team', access: { allowedChats: [] } },
        now: () => now,
        marks: new Map(),
        intake: async (msg) => {
          intake.push(msg.messageId);
        },
      });
    };

    const keepalive = start({
      now: () => now,
      state: () => 'connected',
      onConnectedTick: (at) => ledger.touchLive(at),
      onWakeUp: launchBackfill,
    });

    await keepalive.tick();
    expect(ledger.getLiveAt()).toBe(now);

    now += 5 * 60_000;
    await keepalive.tick();
    await waitFor(() => intake.includes('om_slept'));
    expect(intake).toEqual(['om_slept']);
    await waitFor(() => ledger.getLastBackfillEnd() !== undefined);

    now += 15_000;
    await keepalive.tick();
    expect(ledger.getLiveAt()).toBe(now);
  });
});

function start(opts: {
  now: () => number;
  state: () => 'connected' | 'reconnecting' | 'failed' | undefined;
  onConnectedTick: (now: number) => void;
  onWakeUp?: () => void;
}): KeepaliveHandle {
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
  const handle = startKeepalive({
    channel: {
      getConnectionStatus: () => {
        const state = opts.state();
        return state ? { state, reconnectAttempts: 0 } : undefined;
      },
    } as unknown as LarkChannel,
    domain: 'https://open.example.test',
    forceReconnect: async () => {},
    now: opts.now,
    onConnectedTick: opts.onConnectedTick,
    ...(opts.onWakeUp ? { onWakeUp: opts.onWakeUp } : {}),
  });
  handles.push(handle);
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
