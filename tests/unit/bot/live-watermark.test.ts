import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackfillLedger, LIVE_WATERMARK_THROTTLE_MS } from '../../../src/bot/backfill-ledger';
import { startKeepalive, type KeepaliveHandle } from '../../../src/bot/keepalive';

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
    let now = 1_700_000_000_000;
    const keepalive = start({
      now: () => now,
      state: () => 'connected',
      onConnectedTick,
    });

    await keepalive.tick();
    expect(onConnectedTick).toHaveBeenCalledTimes(1);

    now += 1_000;
    await keepalive.tick();
    expect(onConnectedTick).toHaveBeenCalledTimes(1);

    now += 31_000;
    await keepalive.tick();
    expect(onConnectedTick).toHaveBeenCalledTimes(1);
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
});

function start(opts: {
  now: () => number;
  state: () => 'connected' | 'reconnecting' | 'failed' | undefined;
  onConnectedTick: (now: number) => void;
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
  });
  handles.push(handle);
  return handle;
}
