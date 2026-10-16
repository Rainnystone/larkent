import { describe, expect, it } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { OutboundTimeoutError } from '../../../src/bot/self-message';
import {
  FEISHU_LINK_SILENT_PROBE_MS,
  FEISHU_LINK_SLEEP_MS,
  FEISHU_LINK_TICK_MS,
  createFeishuProbe,
  startFeishuLink,
  type Outage,
} from '../../../src/bot/feishu-link';

describe('FeishuLink', () => {
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
    expect(watermark.value).toBe(now);
  });

  it('treats a 5-minute tick gap as an outage whose scan starts before the sleep', async () => {
    let now = 1_700_000_000_000;
    const start = now;
    const recovered: Outage[] = [];
    const link = startFeishuLink({
      channel: fakeChannel(() => 'connected'),
      probe: async () => true,
      watermark: memoryWatermark(now),
      now: () => now,
    });
    link.onRecovered((outage) => {
      recovered.push(outage);
    });

    await link.tick();
    expect(recovered).toHaveLength(1);
    recovered.length = 0;

    now += 5 * 60_000;
    await link.tick();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.since).toBe(start);
    expect(recovered[0]!.since).toBeLessThan(now - FEISHU_LINK_SLEEP_MS);
    expect(recovered[0]!.until).toBe(now);
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

  it('takes the link down on OutboundTimeoutError and keeps it up on a business 4xx', async () => {
    let now = 1_700_000_000_000;
    let mode: 'ok' | '4xx' | 'hang' = 'ok';
    const channel = {
      getConnectionStatus: () => ({ state: 'connected' as const, reconnectAttempts: 0 }),
      send: () => {
        if (mode === 'hang') return new Promise<never>(() => {});
        if (mode === '4xx') return Promise.reject(httpError(403));
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
      response: { status: 403 },
    });
    expect(link.isDown()).toBe(false);

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
      send: () => Promise.reject(httpError(502)),
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
      response: { status: 502 },
    });
    expect(link.isDown()).toBe(true);
  });

  it('keeps the link up when the authenticated probe gets a business 4xx', async () => {
    await expect(createFeishuProbe(probeChannel(httpError(403)))()).resolves.toBe(true);
    await expect(createFeishuProbe(probeChannel(httpError(429)))()).resolves.toBe(true);
  });

  it('treats 5xx and transport failures as probe-down', async () => {
    await expect(createFeishuProbe(probeChannel(httpError(502)))()).resolves.toBe(false);
    await expect(createFeishuProbe(probeChannel(new Error('ECONNRESET')))()).resolves.toBe(false);
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

function probeChannel(error: Error): LarkChannel {
  return {
    getAppInfo: async () => {
      throw error;
    },
  } as unknown as LarkChannel;
}

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

function fakeChannel(
  state: () => 'connected' | 'reconnecting' | 'failed',
): LarkChannel {
  return {
    getConnectionStatus: () => ({ state: state(), reconnectAttempts: 0 }),
  } as unknown as LarkChannel;
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
