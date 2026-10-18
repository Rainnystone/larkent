import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { OutboundTimeoutError } from '../../../src/bot/self-message';
import { log } from '../../../src/core/logger';
import {
  FEISHU_LINK_PROBE_TIMEOUT_MS,
  FEISHU_LINK_SILENT_PROBE_MS,
  FEISHU_LINK_SLEEP_MS,
  FEISHU_LINK_TICK_MS,
  createFeishuProbe,
  startFeishuLink,
  type Outage,
} from '../../../src/bot/feishu-link';
import { reviewActiveRuns, type ReviewableRun } from '../../../src/bot/recovery';
import { HOST_SLEEP_PROBE_TIMEOUT_MS } from '../../../src/platform/host-sleep';
import {
  axiosErrno,
  axiosHttpError,
  sdkShapedSendError,
} from '../../helpers/sdk-feishu-errors';

describe('FeishuLink', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reconnects on the wake tick after a multi-minute suspend and recovers only after a new-socket frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let now = 1_700_000_000_000;
    const reconnects: number[] = [];
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: notSleepingProbe(),
      reconnect: () => {
        reconnects.push(now);
      },
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });

    await link.tick();
    expect(recovered).toHaveLength(1);
    recovered.length = 0;
    expect(reconnects).toEqual([]);
    const info = vi.spyOn(log, 'info');

    now += 5 * 60_000;
    await link.tick();
    expect(reconnects).toEqual([now]);
    expect(info.mock.calls.some((call) => call[0] === 'link' && call[1] === 'tick-gap')).toBe(true);
    expect(info.mock.calls.some((call) => (
      call[0] === 'link'
      && call[1] === 'wake-reconnect'
      && (call[2] as { gapMs?: number }).gapMs === 5 * 60_000
    ))).toBe(true);
    expect(info.mock.calls.some((call) => call[0] === 'link' && call[1] === 'recovered')).toBe(false);
    expect(recovered).toHaveLength(0);
    expect(link.isDown()).toBe(true);

    now += FEISHU_LINK_TICK_MS;
    await link.tick();
    expect(reconnects).toEqual([now - FEISHU_LINK_TICK_MS]);
    expect(recovered).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recovered).toHaveLength(0);

    link.noteInbound(now);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.hostSuspended).toBe(false);
    expect(recovered[0]!.since).toBe(now - 5 * 60_000 - FEISHU_LINK_TICK_MS);
    expect(recovered[0]!.until).toBe(now);
    expect(link.isDown()).toBe(false);
  });

  it('does not recover from a frame during reconnect or a probe once the socket looks connected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let now = 1_700_000_000_000;
    let state: 'connected' | 'reconnecting' = 'connected';
    const reconnects: number[] = [];
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => state),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: notSleepingProbe(),
      reconnect: () => {
        reconnects.push(now);
        state = 'reconnecting';
      },
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    recovered.length = 0;

    now += 5 * 60_000;
    await link.tick();
    expect(reconnects).toEqual([now]);
    expect(state).toBe('reconnecting');
    link.noteInbound(now);
    expect(recovered).toHaveLength(0);
    expect(link.isDown()).toBe(true);

    state = 'connected';
    now += FEISHU_LINK_TICK_MS;
    await link.tick();
    expect(recovered).toHaveLength(0);
    link.noteSocketFrame(now);
    expect(recovered).toHaveLength(1);
    expect(link.isDown()).toBe(false);
  });

  it('does not recover from a stale connected socket until the wake reconnect settles and a new frame arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let now = 1_700_000_000_000;
    let release: (() => void) | undefined;
    const reconnects: number[] = [];
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: notSleepingProbe(),
      reconnect: () => {
        reconnects.push(now);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    recovered.length = 0;

    now += 5 * 60_000;
    await link.tick();
    expect(reconnects).toEqual([now]);
    expect(release).toBeTypeOf('function');

    link.noteInbound(now);
    expect(recovered).toHaveLength(0);
    expect(link.isDown()).toBe(true);

    link.noteSocketFrame(now);
    expect(recovered).toHaveLength(0);

    release!();
    await Promise.resolve();
    expect(recovered).toHaveLength(1);
    expect(link.isDown()).toBe(false);
  });

  it('recovers on the next connected tick when the new-socket frame arrived before reconnect settled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let now = 1_700_000_000_000;
    let state: 'connected' | 'reconnecting' = 'connected';
    let release: (() => void) | undefined;
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => state),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: notSleepingProbe(),
      reconnect: () => {
        state = 'reconnecting';
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    recovered.length = 0;

    now += 5 * 60_000;
    await link.tick();
    link.noteSocketFrame(now);
    release!();
    await Promise.resolve();
    expect(recovered).toHaveLength(0);
    expect(link.isDown()).toBe(true);

    state = 'connected';
    now += FEISHU_LINK_TICK_MS;
    await link.tick();
    expect(recovered).toHaveLength(1);
    expect(link.isDown()).toBe(false);
  });

  it('recovers from a frame only after the socket returns when the wake reconnect fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let now = 1_700_000_000_000;
    let state: 'connected' | 'reconnecting' = 'connected';
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => state),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: notSleepingProbe(),
      reconnect: () => {
        state = 'reconnecting';
        return Promise.reject(new Error('handshake failed'));
      },
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    recovered.length = 0;

    now += 5 * 60_000;
    await link.tick();
    await Promise.resolve();
    expect(link.isDown()).toBe(true);
    link.noteSocketFrame(now);
    expect(recovered).toHaveLength(0);

    state = 'connected';
    now += FEISHU_LINK_TICK_MS;
    await link.tick();
    expect(recovered).toHaveLength(0);
    link.noteSocketFrame(now);
    expect(recovered).toHaveLength(1);
    expect(link.isDown()).toBe(false);
  });

  it('reconnects on a keepalive wake even when the link tick gap is still under the sleep threshold', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let now = 1_700_000_000_000;
    const reconnects: number[] = [];
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: notSleepingProbe(),
      reconnect: () => {
        reconnects.push(now);
      },
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    recovered.length = 0;

    now += FEISHU_LINK_SLEEP_MS - 1_000;
    await link.tick();
    expect(reconnects).toEqual([]);
    expect(link.isDown()).toBe(false);

    link.noteKeepaliveWake(now);
    expect(reconnects).toEqual([now]);
    expect(recovered).toHaveLength(0);
    expect(link.isDown()).toBe(true);

    link.noteSocketFrame(now);
    expect(recovered).toHaveLength(1);
    expect(link.isDown()).toBe(false);
  });

  it('does not reconnect on a normal tick with no gap', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let now = 1_700_000_000_000;
    const reconnects: number[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: notSleepingProbe(),
      reconnect: () => {
        reconnects.push(now);
      },
    });
    await link.tick();
    for (let n = 0; n < 4; n++) {
      now += FEISHU_LINK_TICK_MS;
      await link.tick();
    }
    expect(reconnects).toEqual([]);
    expect(link.isDown()).toBe(false);
  });

  it('reconnects once when keepalive wake-up and the tick gap are the same suspend, and a pong recovers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let now = 1_700_000_000_000;
    const reconnects: number[] = [];
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: sleepingProbe(),
      reconnect: () => {
        reconnects.push(now);
      },
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    recovered.length = 0;

    now += 5 * 60_000;
    link.noteKeepaliveWake(now);
    expect(reconnects).toEqual([now]);
    expect(recovered).toHaveLength(0);
    expect(link.isDown()).toBe(true);

    await link.tick();
    expect(reconnects).toEqual([now]);
    expect(recovered).toHaveLength(0);

    link.noteSocketFrame(now);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.hostSuspended).toBe(true);
    expect(link.isDown()).toBe(false);

    link.noteSocketFrame(now);
    expect(recovered).toHaveLength(1);
  });

  it('stays up when the tick gap follows a pong on the keepalive wake', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let now = 1_700_000_000_000;
    const reconnects: number[] = [];
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: notSleepingProbe(),
      reconnect: () => {
        reconnects.push(now);
      },
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    recovered.length = 0;

    now += 5 * 60_000;
    link.noteKeepaliveWake(now);
    link.noteSocketFrame(now);
    expect(recovered).toHaveLength(1);
    expect(link.isDown()).toBe(false);

    await link.tick();
    expect(reconnects).toEqual([now]);
    expect(recovered).toHaveLength(1);
    expect(link.isDown()).toBe(false);
  });

  it('records host suspend when a wake frame arrives before the interval tick', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let now = 1_700_000_000_000;
    const reconnects: number[] = [];
    const recovered: Outage[] = [];
    const openTool: ReviewableRun = {
      lastEventAt: now - 1,
      interrupted: false,
      hasOpenToolCall: true,
    };
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: sleepingProbe(),
      reconnect: () => {
        reconnects.push(now);
      },
    });
    await link.tick();
    link.onRecovered((outage) => {
      recovered.push(outage);
      reviewActiveRuns([openTool], outage);
    });

    now += 5 * 60_000;
    link.noteKeepaliveWake(now);
    link.noteSocketFrame(now);
    expect(link.isDown()).toBe(false);

    await link.tick();
    expect(reconnects).toEqual([now]);
    expect(link.isDown()).toBe(false);
    expect(recovered.some((outage) => outage.hostSuspended)).toBe(true);
    expect(openTool.stallDeadlineMs).toBe(2 * 60_000);
  });

  it('emits one recovered outage after a 2 min probe failure while WS stays connected', async () => {
    let now = 1_700_000_000_000;
    const watermark = { value: now as number | undefined };
    let probeOk = true;
    const probes: number[] = [];
    const recovered: Outage[] = [];
    const failureStart = now + FEISHU_LINK_SILENT_PROBE_MS;

    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: async () => {
        probes.push(now);
        return probeOk;
      },
      watermark: {
        get: () => watermark.value,
        set: (at) => {
          watermark.value = at;
        },
      },
      now: () => now,
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });

    await link.tick();
    expect(link.isDown()).toBe(false);
    expect(recovered).toHaveLength(1);
    recovered.length = 0;

    probeOk = false;
    while (now < failureStart) {
      now += FEISHU_LINK_TICK_MS;
      await link.tick();
    }
    expect(link.isDown()).toBe(true);
    expect(recovered).toHaveLength(0);

    const downFor = now + 2 * 60_000;
    while (now < downFor) {
      now += FEISHU_LINK_TICK_MS;
      await link.tick();
    }
    expect(link.isDown()).toBe(true);
    expect(recovered).toHaveLength(0);

    probeOk = true;
    now += FEISHU_LINK_TICK_MS;
    await link.tick();

    expect(link.isDown()).toBe(false);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.since).toBeLessThanOrEqual(failureStart);
    expect(recovered[0]!.until).toBe(now);
    expect(recovered[0]!.hostSuspended).toBe(false);
    expect(watermark.value).toBe(now);
  });

  it('treats a 5-minute tick gap as an outage without hostSuspended', async () => {
    let now = 1_700_000_000_000;
    const start = now;
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: notSleepingProbe(),
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });

    await link.tick();
    expect(recovered).toHaveLength(1);
    recovered.length = 0;

    now += 5 * 60_000;
    await link.tick();
    expect(recovered).toHaveLength(0);
    link.noteInbound(now);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.since).toBe(start);
    expect(recovered[0]!.since).toBeLessThan(now - FEISHU_LINK_SLEEP_MS);
    expect(recovered[0]!.until).toBe(now);
    expect(recovered[0]!.hostSuspended).toBe(false);
  });

  it('sets hostSuspended only when the OS sleep probe finds evidence in the gap', async () => {
    let now = 1_700_000_000_000;
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: sleepingProbe(),
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    recovered.length = 0;
    now += 5 * 60_000;
    await link.tick();
    expect(recovered).toHaveLength(0);
    link.noteInbound(now);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.hostSuspended).toBe(true);
    expect(recovered[0]!.suspendStartedAt).toBe(now - 5 * 60_000);
  });

  it('does not set hostSuspended when the OS sleep probe fails', async () => {
    let now = 1_700_000_000_000;
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: {
        note() {},
        async detect() {
          throw new Error('sysctl failed');
        },
      },
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    recovered.length = 0;
    now += 5 * 60_000;
    await link.tick();
    expect(recovered).toHaveLength(0);
    link.noteInbound(now);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.hostSuspended).toBe(false);
  });

  it('does not block recovery when the OS sleep probe hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 1_700_000_000_000;
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: {
        note() {},
        detect: () => new Promise(() => {}),
      },
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    recovered.length = 0;
    now += 5 * 60_000;
    const pending = link.tick();
    await vi.advanceTimersByTimeAsync(HOST_SLEEP_PROBE_TIMEOUT_MS);
    await pending;
    expect(recovered).toHaveLength(0);
    expect(link.isDown()).toBe(true);
    link.noteInbound(now);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.hostSuspended).toBe(false);
    expect(link.isDown()).toBe(false);
  });

  it('keeps suspendStartedAt on the last local tick when later ws-down pulls since back to Feishu evidence', async () => {
    let now = 1_700_000_000_000;
    const evidence = now;
    let state: 'connected' | 'reconnecting' = 'connected';
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => state),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: sleepingProbe(),
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    recovered.length = 0;

    now += FEISHU_LINK_TICK_MS;
    await link.tick();
    const lastTickBeforeSleep = now;

    now += 90_000;
    state = 'reconnecting';
    await link.tick();
    expect(link.isDown()).toBe(true);

    state = 'connected';
    now += FEISHU_LINK_TICK_MS;
    await link.tick();
    expect(recovered).toHaveLength(0);
    link.noteInbound(now);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.hostSuspended).toBe(true);
    expect(recovered[0]!.since).toBe(evidence);
    expect(recovered[0]!.suspendStartedAt).toBe(lastTickBeforeSleep);
    expect(recovered[0]!.suspendStartedAt).toBeGreaterThan(recovered[0]!.since);
  });

  it('stays down on a failed socket while the probe is healthy', async () => {
    let now = 1_700_000_000_000;
    let state: 'connected' | 'failed' = 'connected';
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => state),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    recovered.length = 0;

    state = 'failed';
    const stuckUntil = now + 60_000;
    while (now < stuckUntil) {
      now += FEISHU_LINK_TICK_MS;
      await link.tick();
    }
    expect(link.isDown()).toBe(true);
    expect(recovered).toHaveLength(0);

    now += FEISHU_LINK_TICK_MS;
    state = 'connected';
    await link.tick();
    expect(link.isDown()).toBe(false);
    expect(recovered).toHaveLength(1);
  });

  it('recovers a 20-second reconnect so a scan can run', async () => {
    let now = 1_700_000_000_000;
    let state: 'connected' | 'reconnecting' = 'connected';
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => state),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });

    await link.tick();
    recovered.length = 0;

    now += 1_000;
    state = 'reconnecting';
    await link.tick();
    expect(link.isDown()).toBe(true);

    now += 20_000;
    state = 'connected';
    await link.tick();
    expect(link.isDown()).toBe(false);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.until - recovered[0]!.since).toBeGreaterThanOrEqual(20_000);
  });

  it('recovers a sub-5s reconnect on an explicit tick', async () => {
    let now = 1_700_000_000_000;
    let state: 'connected' | 'reconnecting' = 'connected';
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => state),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    recovered.length = 0;

    now += 1_000;
    state = 'reconnecting';
    await link.tick();
    now += 1_000;
    state = 'connected';
    await link.tick();
    expect(recovered).toHaveLength(1);
    expect(link.isDown()).toBe(false);
  });

  it('does not go up on inbound while the WebSocket is reconnecting', async () => {
    let now = 1_700_000_000_000;
    let state: 'connected' | 'reconnecting' = 'connected';
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => state),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    recovered.length = 0;

    now += 1_000;
    state = 'reconnecting';
    await link.tick();
    expect(link.isDown()).toBe(true);

    now += 1_000;
    link.noteInbound(now);
    expect(link.isDown()).toBe(true);
    expect(recovered).toHaveLength(0);
  });

  it('takes the link down on OutboundTimeoutError and keeps it up on a rejected 4xx', async () => {
    let now = 1_700_000_000_000;
    let mode: 'ok' | '4xx' | 'hang' = 'ok';
    const channel = {
      getConnectionStatus: () => ({ state: 'connected' as const, reconnectAttempts: 0 }),
      send: () => {
        if (mode === 'hang') return new Promise<never>(() => {});
        if (mode === '4xx') {
          return Promise.reject(sdkShapedSendError('permission_denied', axiosHttpError(403, 'Bot is not in the chat')));
        }
        return Promise.resolve({ messageId: 'om_ok' });
      },
    } as unknown as LarkChannel;
    const link = startFeishuLink({
      channel,
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      outboundTimeoutMs: 30,
    });
    await link.tick();
    expect(link.isDown()).toBe(false);

    mode = '4xx';
    await expect(channel.send('oc', { markdown: 'denied' })).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(link.isDown()).toBe(false);
    expect(link.outageEpoch()).toBe(0);

    mode = 'hang';
    await expect(channel.send('oc', { markdown: 'slow' })).rejects.toBeInstanceOf(OutboundTimeoutError);
    expect(link.isDown()).toBe(true);
  });

  it('treats a slow-but-successful outbound as evidence and does not duplicate it', async () => {
    let now = 1_700_000_000_000;
    const watermark = memoryWatermark(now);
    let sends = 0;
    const channel = {
      getConnectionStatus: () => ({ state: 'connected' as const, reconnectAttempts: 0 }),
      send: () => new Promise<{ messageId: string }>((resolve) => {
        sends += 1;
        setTimeout(() => resolve({ messageId: 'om_slow' }), 40);
      }),
    } as unknown as LarkChannel;
    const link = startFeishuLink({
      channel,
      probe: async () => true,
      watermark,
      now: () => now,
      outboundTimeoutMs: 200,
    });
    await link.tick();
    expect(link.isDown()).toBe(false);
    const afterProbe = watermark.get();

    now += FEISHU_LINK_TICK_MS;
    await expect(channel.send('oc', { markdown: 'slow ok' })).resolves.toEqual({ messageId: 'om_slow' });
    expect(link.isDown()).toBe(false);
    expect(sends).toBe(1);
    expect(watermark.get()).toBe(now);
    expect(watermark.get()).not.toBe(afterProbe);
  });

  it('takes the link down on outbound 5xx', async () => {
    let now = 1_700_000_000_000;
    const channel = {
      getConnectionStatus: () => ({ state: 'connected' as const, reconnectAttempts: 0 }),
      send: () => Promise.reject(sdkShapedSendError('unknown', axiosHttpError(502))),
    } as unknown as LarkChannel;
    const link = startFeishuLink({
      channel,
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
    });
    await link.tick();
    expect(link.isDown()).toBe(false);
    await expect(channel.send('oc', { markdown: 'fail' })).rejects.toMatchObject({
      code: 'unknown',
    });
    expect(link.isDown()).toBe(true);
  });

  it('takes the link down on SDK-wrapped ENETUNREACH and keeps it up on a local bug', async () => {
    let now = 1_700_000_000_000;
    let mode: 'ok' | 'net' | 'bug' = 'ok';
    const channel = {
      getConnectionStatus: () => ({ state: 'connected' as const, reconnectAttempts: 0 }),
      send: () => {
        if (mode === 'net') {
          return Promise.reject(sdkShapedSendError(
            'unknown',
            axiosErrno('ENETUNREACH', 'connect ENETUNREACH 1.2.3.4:443'),
          ));
        }
        if (mode === 'bug') return Promise.reject(new TypeError('x is not a function'));
        return Promise.resolve({ messageId: 'om_ok' });
      },
    } as unknown as LarkChannel;
    const link = startFeishuLink({
      channel,
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
    });
    await link.tick();
    expect(link.isDown()).toBe(false);
    const epoch = link.outageEpoch();

    mode = 'bug';
    await expect(channel.send('oc', { markdown: 'bug' })).rejects.toBeInstanceOf(TypeError);
    expect(link.isDown()).toBe(false);
    expect(link.outageEpoch()).toBe(epoch);

    mode = 'net';
    await expect(channel.send('oc', { markdown: 'net' })).rejects.toMatchObject({ code: 'unknown' });
    expect(link.isDown()).toBe(true);
    expect(link.outageEpoch()).toBe(epoch + 1);
  });

  it('does not treat a 5-minute stream producer as an outage', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 1_700_000_000_000;
    const recovered: Outage[] = [];
    const channel = {
      getConnectionStatus: () => ({ state: 'connected' as const, reconnectAttempts: 0 }),
      stream: async (
        _chatId: string,
        input: {
          markdown?: (ctrl: { messageId: string; setContent: (text: string) => Promise<void> }) => Promise<void>;
        },
      ) => {
        await input.markdown?.(new (class {
          get messageId(): string {
            return 'om_s';
          }
          async setContent(_text: string): Promise<void> {}
        })());
        return { messageId: 'om_s' };
      },
    } as unknown as LarkChannel;
    const link = startFeishuLink({
      channel,
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: notSleepingProbe(),
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    recovered.length = 0;
    expect(link.isDown()).toBe(false);
    const epoch = link.outageEpoch();

    const pending = channel.stream('oc', {
      markdown: async (ctrl) => {
        await ctrl.setContent('partial');
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5 * 60_000);
        });
      },
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(pending).resolves.toEqual({ messageId: 'om_s' });
    expect(link.isDown()).toBe(false);
    expect(link.outageEpoch()).toBe(epoch);
    expect(recovered).toHaveLength(0);
  });

  it('keeps the link up when the authenticated probe gets a rejected 4xx', async () => {
    await expect(createFeishuProbe(probeChannel(axiosHttpError(403)))()).resolves.toBe(true);
    await expect(createFeishuProbe(probeChannel(axiosHttpError(400)))()).resolves.toBe(true);
  });

  it('treats a 429 probe as a link failure', async () => {
    await expect(createFeishuProbe(probeChannel(axiosHttpError(429)))()).resolves.toBe(false);
  });

  it('treats 5xx and transport failures as probe-down', async () => {
    await expect(createFeishuProbe(probeChannel(axiosHttpError(502)))()).resolves.toBe(false);
    await expect(createFeishuProbe(probeChannel(axiosErrno('ECONNRESET', 'read ECONNRESET')))()).resolves.toBe(false);
  });

  it('treats a local probe bug as neither evidence nor a link outage', async () => {
    await expect(createFeishuProbe(probeChannel(new TypeError('x is not a function')))()).resolves.toBe(
      'unknown',
    );
  });

  it('does not take the link down when a silent probe throws a local bug', async () => {
    let now = 1_700_000_000_000;
    let failLocal = false;
    const recovered: Outage[] = [];
    const channel = {
      getConnectionStatus: () => ({ state: 'connected' as const, reconnectAttempts: 0 }),
      getAppInfo: async () => {
        if (failLocal) throw new TypeError('x is not a function');
        return { ownerId: 'ou_owner' };
      },
    } as unknown as LarkChannel;
    const link = startFeishuLink({
      channel,
      probe: createFeishuProbe(channel),
      watermark: memoryWatermark(now),
      now: () => now,
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    expect(link.isDown()).toBe(false);
    recovered.length = 0;
    const epoch = link.outageEpoch();

    failLocal = true;
    const silentUntil = now + FEISHU_LINK_SILENT_PROBE_MS;
    do {
      now += FEISHU_LINK_TICK_MS;
      await link.tick();
    } while (now < silentUntil);
    expect(link.isDown()).toBe(false);
    expect(link.outageEpoch()).toBe(epoch);
    expect(recovered).toHaveLength(0);
  });

  it('ignores a late getAppInfo after the probe is aborted', async () => {
    let finish: ((info: { ownerId: string }) => void) | undefined;
    const channel = probeChannel(new Error('unused'));
    channel.getAppInfo = () => new Promise((resolve) => {
      finish = resolve;
    });
    const ctrl = new AbortController();
    const pending = createFeishuProbe(channel)(ctrl.signal);
    ctrl.abort();
    await expect(pending).resolves.toBe(false);
    finish?.({ ownerId: 'ou_owner' });
  });

  it('does not treat a slow but successful probe as host sleep', async () => {
    const recovered = await hangSilentProbe({
      onHang: (clock) => {
        clock.now += 10_000;
      },
    });
    expect(recovered.link.isDown()).toBe(false);
    expect(recovered.outages).toHaveLength(0);
  });

  it('detects a tick gap during an in-flight probe, ignores the late result, and recovers once', async () => {
    let now = 1_700_000_000_000;
    const outages: Outage[] = [];
    let probes = 0;
    const hanging: Array<(ok: boolean) => void> = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: () => {
        probes += 1;
        if (probes === 1) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          hanging.push(resolve);
        });
      },
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: notSleepingProbe(),
    });
    link.onRecovered((outage) => {
      outages.push(outage);
    });
    await link.tick();
    expect(link.isDown()).toBe(false);
    outages.length = 0;

    let probing: Promise<void> | undefined;
    const silentUntil = now + FEISHU_LINK_SILENT_PROBE_MS;
    while (hanging.length === 0) {
      now += FEISHU_LINK_TICK_MS;
      probing = link.tick();
      if (hanging.length === 0) await probing;
    }
    expect(hanging).toHaveLength(1);
    const lateProbe = hanging[0]!;
    const probeStartedAt = now;

    now += 5 * 60_000;
    probing = link.tick();
    await Promise.resolve();
    expect(hanging).toHaveLength(2);

    lateProbe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(outages).toHaveLength(0);
    expect(link.isDown()).toBe(true);

    hanging[1]!(true);
    await probing;
    expect(outages).toHaveLength(0);
    expect(link.isDown()).toBe(true);
    link.noteInbound(now);
    expect(outages).toHaveLength(1);
    expect(outages[0]!.hostSuspended).toBe(false);
    expect(outages[0]!.since).toBe(probeStartedAt);
    expect(outages[0]!.until).toBe(now);
    expect(link.isDown()).toBe(false);
  });

  it('takes the link down when a hung probe timer resumes after a tick gap without calling it suspend', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 1_700_000_000_000;
    const outages: Outage[] = [];
    let hang = false;
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: () => {
        if (!hang) return Promise.resolve(true);
        return new Promise<boolean>(() => {});
      },
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: notSleepingProbe(),
    });
    link.onRecovered((outage) => {
      outages.push(outage);
    });
    await link.tick();
    outages.length = 0;

    hang = true;
    let probing: Promise<void> | undefined;
    const silentUntil = now + FEISHU_LINK_SILENT_PROBE_MS;
    while (now < silentUntil) {
      now += FEISHU_LINK_TICK_MS;
      probing = link.tick();
      if (now < silentUntil) await probing;
    }
    expect(link.isDown()).toBe(false);

    // Freeze: wall jumps while the 20s probe timer is still armed. No interval
    // tick runs first; the timeout completing must not stamp lastTickAt and
    // hide the gap.
    now += 5 * 60_000;
    await vi.advanceTimersByTimeAsync(FEISHU_LINK_PROBE_TIMEOUT_MS);
    await probing;
    expect(link.isDown()).toBe(true);

    hang = false;
    now += FEISHU_LINK_TICK_MS;
    await link.tick();
    expect(outages).toHaveLength(0);
    link.noteInbound(now);
    expect(outages).toHaveLength(1);
    expect(outages[0]!.hostSuspended).toBe(false);
  });

  it('times out a hung probe below the sleep threshold without counting it as suspend', async () => {
    expect(FEISHU_LINK_PROBE_TIMEOUT_MS).toBeLessThan(FEISHU_LINK_SLEEP_MS);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 1_700_000_000_000;
    const outages: Outage[] = [];
    let hang = false;
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: () => {
        if (!hang) return Promise.resolve(true);
        return new Promise<boolean>(() => {});
      },
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: notSleepingProbe(),
    });
    link.onRecovered((outage) => {
      outages.push(outage);
    });
    await link.tick();
    expect(link.isDown()).toBe(false);
    outages.length = 0;

    hang = true;
    let probing: Promise<void> | undefined;
    const silentUntil = now + FEISHU_LINK_SILENT_PROBE_MS;
    while (now < silentUntil) {
      now += FEISHU_LINK_TICK_MS;
      probing = link.tick();
      if (now < silentUntil) await probing;
    }
    await vi.advanceTimersByTimeAsync(FEISHU_LINK_PROBE_TIMEOUT_MS);
    await probing;
    expect(outages).toHaveLength(0);
    expect(link.isDown()).toBe(true);

    hang = false;
    const sleep = vi.spyOn(log, 'info');
    now += FEISHU_LINK_TICK_MS;
    await link.tick();
    expect(sleep.mock.calls.some((call) => call[0] === 'link' && call[1] === 'sleep')).toBe(false);
    expect(outages).toHaveLength(1);
    expect(outages[0]!.hostSuspended).toBe(false);
  });

  it('aborts a hung getAppInfo at the probe timeout so a late success cannot take the link up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 1_700_000_000_000;
    let hang = false;
    let finish: ((info: { ownerId: string }) => void) | undefined;
    const signals: AbortSignal[] = [];
    const channel = {
      getConnectionStatus: () => ({ state: 'connected' as const, reconnectAttempts: 0 }),
      getAppInfo: () => {
        if (!hang) return Promise.resolve({ ownerId: 'ou_owner' });
        return new Promise<{ ownerId: string }>((resolve) => {
          finish = resolve;
        });
      },
    } as unknown as LarkChannel;
    const inner = createFeishuProbe(channel);
    const link = startFeishuLink({
      channel,
      probe: (signal) => {
        if (signal) signals.push(signal);
        return inner(signal);
      },
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: notSleepingProbe(),
    });
    await link.tick();
    expect(link.isDown()).toBe(false);

    hang = true;
    let probing: Promise<void> | undefined;
    const silentUntil = now + FEISHU_LINK_SILENT_PROBE_MS;
    while (now < silentUntil) {
      now += FEISHU_LINK_TICK_MS;
      probing = link.tick();
      if (now < silentUntil) await probing;
    }
    expect(link.isDown()).toBe(false);
    await vi.advanceTimersByTimeAsync(FEISHU_LINK_PROBE_TIMEOUT_MS);
    await probing;
    expect(link.isDown()).toBe(true);
    expect(signals.at(-1)?.aborted).toBe(true);

    finish?.({ ownerId: 'ou_owner' });
    await Promise.resolve();
    await Promise.resolve();
    expect(link.isDown()).toBe(true);
  });

  it('bounds a hung probe with the probe timer without waiting for the next tick', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 1_700_000_000_000;
    const recovered: Outage[] = [];
    let hang = false;
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: () => {
        if (!hang) return Promise.resolve(true);
        return new Promise<boolean>(() => {});
      },
      watermark: memoryWatermark(now),
      now: () => now,
      sleepProbe: notSleepingProbe(),
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });
    await link.tick();
    expect(link.isDown()).toBe(false);
    recovered.length = 0;

    hang = true;
    let probing: Promise<void> | undefined;
    const silentUntil = now + FEISHU_LINK_SILENT_PROBE_MS;
    while (now < silentUntil) {
      now += FEISHU_LINK_TICK_MS;
      probing = link.tick();
      if (now < silentUntil) await probing;
    }
    expect(link.isDown()).toBe(false);
    await vi.advanceTimersByTimeAsync(FEISHU_LINK_PROBE_TIMEOUT_MS);
    await probing;
    expect(recovered).toHaveLength(0);
    expect(link.isDown()).toBe(true);
  });

  it('marks hostSuspended false when a failed probe is the only outage evidence', async () => {
    let now = 1_700_000_000_000;
    let probeOk = true;
    const outages: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: async () => probeOk,
      watermark: memoryWatermark(now),
      now: () => now,
    });
    link.onRecovered((outage) => {
      outages.push(outage);
    });
    await link.tick();
    outages.length = 0;

    probeOk = false;
    const silentUntil = now + FEISHU_LINK_SILENT_PROBE_MS;
    while (now < silentUntil) {
      now += FEISHU_LINK_TICK_MS;
      await link.tick();
    }
    expect(link.isDown()).toBe(true);

    probeOk = true;
    now += FEISHU_LINK_TICK_MS;
    await link.tick();
    expect(outages).toHaveLength(1);
    expect(outages[0]!.hostSuspended).toBe(false);
    expect(link.isDown()).toBe(false);
  });

  it('records the outage origin before advancing the live watermark', async () => {
    let now = 1_700_000_000_000;
    const events: string[] = [];
    let live = now;
    let state: 'connected' | 'reconnecting' = 'connected';
    const link = startFeishuLink({
      channel: fakeChannel(() => state),
      probe: async () => true,
      watermark: {
        get: () => live,
        holdOutage: (since) => {
          events.push(`hold:${since}`);
        },
        set: (at) => {
          events.push(`set:${at}`);
          live = at;
        },
      },
      now: () => now,
    });
    await link.tick();
    events.length = 0;

    state = 'reconnecting';
    await link.tick();
    now += FEISHU_LINK_TICK_MS;
    state = 'connected';
    await link.tick();

    expect(events[0]).toMatch(/^hold:/);
    expect(events[1]).toMatch(/^set:/);
    expect(Number(events[0]!.slice('hold:'.length))).toBeLessThan(Number(events[1]!.slice('set:'.length)));
  });

  it('does not advance the watermark on connected ticks without evidence', async () => {
    let now = 1_700_000_000_000;
    const watermark = memoryWatermark(now);
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: async () => true,
      watermark,
      now: () => now,
    });
    await link.tick();
    const afterEvidence = watermark.get();

    for (let n = 0; n < 3; n++) {
      now += FEISHU_LINK_TICK_MS;
      await link.tick();
    }
    expect(watermark.get()).toBe(afterEvidence);

    while (now - (afterEvidence ?? now) < FEISHU_LINK_SILENT_PROBE_MS) {
      now += FEISHU_LINK_TICK_MS;
    }
    await link.tick();
    expect(watermark.get()).toBe(now);
  });
});

async function hangSilentProbe(opts: {
  onHang: (clock: { now: number }) => void;
}): Promise<{
  link: ReturnType<typeof startFeishuLink>;
  outages: Outage[];
  probeStartedAt: number;
  clock: { now: number };
}> {
  const clock = { now: 1_700_000_000_000 };
  const outages: Outage[] = [];
  let hangProbe = false;
  let releaseProbe: ((ok: boolean) => void) | undefined;
  const link = startFeishuLink({
    channel: fakeChannel(() => 'connected'),
    probe: () => {
      if (!hangProbe) return Promise.resolve(true);
      hangProbe = false;
      return new Promise<boolean>((resolve) => {
        releaseProbe = resolve;
      });
    },
    watermark: memoryWatermark(clock.now),
    now: () => clock.now,
    sleepProbe: notSleepingProbe(),
  });
  link.onRecovered((outage) => {
    outages.push(outage);
  });

  await link.tick();
  expect(link.isDown()).toBe(false);
  outages.length = 0;

  hangProbe = true;
  let probing: Promise<void> | undefined;
  let probeStartedAt = clock.now;
  for (let n = 0; n < 8 && !releaseProbe; n++) {
    clock.now += FEISHU_LINK_TICK_MS;
    probing = link.tick();
    if (!releaseProbe) await probing;
  }
  expect(releaseProbe).toBeTypeOf('function');
  probeStartedAt = clock.now;
  opts.onHang(clock);
  await link.tick();
  releaseProbe?.(true);
  await probing;
  return { link, outages, probeStartedAt, clock };
}

function probeChannel(error: Error): LarkChannel {
  return {
    getAppInfo: async () => {
      throw error;
    },
  } as unknown as LarkChannel;
}

function fakeChannel(
  state: () => 'connected' | 'reconnecting' | 'failed',
): LarkChannel {
  return {
    getConnectionStatus: () => ({ state: state(), reconnectAttempts: 0 }),
  } as unknown as LarkChannel;
}

function notSleepingProbe(): {
  note(): void;
  detect(): Promise<{ suspended: false }>;
} {
  return {
    note() {},
    async detect() {
      return { suspended: false };
    },
  };
}

function sleepingProbe(): {
  note(): void;
  detect(gap: { fromMs: number; toMs: number }): Promise<{ suspended: true; suspendStartedAt: number }>;
} {
  return {
    note() {},
    async detect(gap) {
      return { suspended: true, suspendStartedAt: gap.fromMs };
    },
  };
}

function memoryWatermark(initial?: number): { get(): number | undefined; set(at: number): void } {
  let value = initial;
  return {
    get: () => value,
    set: (at) => {
      value = at;
    },
  };
}
