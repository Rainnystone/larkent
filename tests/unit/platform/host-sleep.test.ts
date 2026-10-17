import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_SLEEP_MIN_MS,
  HOST_SLEEP_PROBE_TIMEOUT_MS,
  createHostSleepProbe,
  darwinSleepEvidence,
  linuxSleepMs,
  parseProcUptime,
  parseSysctlTime,
  parseWindowsKernelPower,
  windowsSleepEvidence,
} from '../../../src/platform/host-sleep';

describe('linux boottime vs monotonic', () => {
  it('parses /proc/uptime seconds', () => {
    expect(parseProcUptime('12345.67 89012.34\n')).toBeCloseTo(12345.67, 5);
    expect(parseProcUptime('not-a-number')).toBeUndefined();
  });

  it('treats boottime growing faster than hrtime as a real suspend', () => {
    const sleptMs = linuxSleepMs(
      { uptimeSec: 1_000, monoNs: 5_000_000_000n },
      { uptimeSec: 1_060, monoNs: 8_000_000_000n },
    );
    expect(sleptMs).toBe(57_000);
    expect(sleptMs).toBeGreaterThan(HOST_SLEEP_MIN_MS);
  });

  it('does not treat a SIGSTOP freeze as suspend when both clocks advance together', () => {
    const sleptMs = linuxSleepMs(
      { uptimeSec: 1_000, monoNs: 5_000_000_000n },
      { uptimeSec: 1_008, monoNs: 13_000_000_000n },
    );
    expect(sleptMs).toBe(0);
  });
});

describe('macOS kern.sleeptime / kern.waketime', () => {
  const gap = { fromMs: 1_700_000_000_000, toMs: 1_700_000_090_000 };

  it('parses sysctl { sec } and a ctime string', () => {
    expect(parseSysctlTime('{ sec = 1700000060, usec = 12 } Thu Nov 14 22:14:20 2023'))
      .toBe(1_700_000_060_000);
    expect(parseSysctlTime('1700000060')).toBe(1_700_000_060_000);
  });

  it('marks suspend when a wake falls inside the gap', () => {
    const evidence = darwinSleepEvidence({
      sleepMs: 1_700_000_010_000,
      wakeMs: 1_700_000_070_000,
      gap,
    });
    expect(evidence).toEqual({
      suspended: true,
      suspendStartedAt: 1_700_000_010_000,
    });
  });

  it('does not mark suspend when the last wake is outside the gap', () => {
    expect(darwinSleepEvidence({
      sleepMs: 1_699_000_000_000,
      wakeMs: 1_699_000_030_000,
      gap,
    })).toEqual({ suspended: false });
  });
});

describe('Windows Kernel-Power log', () => {
  const gap = { fromMs: 1_700_000_000_000, toMs: 1_700_000_090_000 };

  it('parses sleep/wake EventIDs and SystemTime', () => {
    const xml = `
      <Event><System>
        <EventID>42</EventID>
        <TimeCreated SystemTime="2023-11-14T22:13:20.000Z"/>
      </System></Event>
      <Event><System>
        <EventID>107</EventID>
        <TimeCreated SystemTime="2023-11-14T22:14:20.000Z"/>
      </System></Event>
    `;
    expect(parseWindowsKernelPower(xml)).toEqual([
      { atMs: Date.parse('2023-11-14T22:13:20.000Z'), eventId: 42 },
      { atMs: Date.parse('2023-11-14T22:14:20.000Z'), eventId: 107 },
    ]);
  });

  it('marks suspend when a sleep or wake event falls inside the gap', () => {
    expect(windowsSleepEvidence({
      events: [
        { atMs: 1_700_000_010_000, eventId: 42 },
        { atMs: 1_700_000_070_000, eventId: 107 },
      ],
      gap,
    })).toEqual({
      suspended: true,
      suspendStartedAt: 1_700_000_010_000,
    });
  });

  it('does not mark suspend when the log has no power transition in the gap', () => {
    expect(windowsSleepEvidence({
      events: [{ atMs: 1_699_000_000_000, eventId: 42 }],
      gap,
    })).toEqual({ suspended: false });
  });
});

describe('createHostSleepProbe', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('linux: injected boottime growth reports suspended', async () => {
    const uptimes = ['1000.00 0', '1060.00 0'];
    const monos = [1_000_000_000n, 4_000_000_000n];
    const probe = createHostSleepProbe({
      platform: 'linux',
      timeoutMs: 200,
      readUptime: async () => uptimes.shift() ?? '1060.00 0',
      hrtime: () => monos.shift() ?? 4_000_000_000n,
    });
    await probe.note(1_700_000_000_000);
    await expect(probe.detect({
      fromMs: 1_700_000_000_000,
      toMs: 1_700_000_060_000,
    })).resolves.toMatchObject({ suspended: true });
  });

  it('linux: a concurrent post-wake note does not erase boottime evidence', async () => {
    const uptimes = ['1000.00 0', '1060.00 0', '1060.10 0'];
    const monos = [1_000_000_000n, 4_000_000_000n, 4_100_000_000n];
    const probe = createHostSleepProbe({
      platform: 'linux',
      timeoutMs: 200,
      readUptime: async () => uptimes.shift() ?? '1060.10 0',
      hrtime: () => monos.shift() ?? 4_100_000_000n,
    });
    await probe.note(1_700_000_000_000);
    const detect = probe.detect({
      fromMs: 1_700_000_000_000,
      toMs: 1_700_000_060_000,
    });
    void probe.note(1_700_000_060_000);
    await expect(detect).resolves.toMatchObject({ suspended: true });
  });

  it('linux: injected equal clock growth is a freeze, not suspend', async () => {
    const uptimes = ['1000.00 0', '1008.00 0'];
    const monos = [1_000_000_000n, 9_000_000_000n];
    const probe = createHostSleepProbe({
      platform: 'linux',
      timeoutMs: 200,
      readUptime: async () => uptimes.shift() ?? '1008.00 0',
      hrtime: () => monos.shift() ?? 9_000_000_000n,
    });
    await probe.note(1_700_000_000_000);
    await expect(probe.detect({
      fromMs: 1_700_000_000_000,
      toMs: 1_700_000_008_000,
    })).resolves.toEqual({ suspended: false });
  });

  it('linux: probe failure is not suspended', async () => {
    const probe = createHostSleepProbe({
      platform: 'linux',
      timeoutMs: 200,
      readUptime: async () => {
        throw new Error('EACCES /proc/uptime');
      },
      hrtime: () => 1n,
    });
    await probe.note(1_700_000_000_000);
    await expect(probe.detect({
      fromMs: 1_700_000_000_000,
      toMs: 1_700_000_060_000,
    })).resolves.toEqual({ suspended: false });
  });

  it('darwin: injected waketime inside the gap reports suspended', async () => {
    const probe = createHostSleepProbe({
      platform: 'darwin',
      timeoutMs: 200,
      sysctl: async (key) => {
        if (key === 'kern.sleeptime') return '{ sec = 1700000010, usec = 0 }';
        if (key === 'kern.waketime') return '{ sec = 1700000070, usec = 0 }';
        throw new Error(`unexpected ${key}`);
      },
    });
    await expect(probe.detect({
      fromMs: 1_700_000_000_000,
      toMs: 1_700_000_090_000,
    })).resolves.toEqual({
      suspended: true,
      suspendStartedAt: 1_700_000_010_000,
    });
  });

  it('darwin: sysctl failure is not suspended', async () => {
    const probe = createHostSleepProbe({
      platform: 'darwin',
      timeoutMs: 200,
      sysctl: async () => {
        throw new Error('sysctl: unknown oid');
      },
    });
    await expect(probe.detect({
      fromMs: 1_700_000_000_000,
      toMs: 1_700_000_090_000,
    })).resolves.toEqual({ suspended: false });
  });

  it('win32: injected Kernel-Power events inside the gap report suspended', async () => {
    const probe = createHostSleepProbe({
      platform: 'win32',
      timeoutMs: 200,
      queryKernelPower: async () => `
        <Event><System>
          <EventID>42</EventID>
          <TimeCreated SystemTime="2023-11-14T22:13:30.000Z"/>
        </System></Event>
      `,
    });
    const gap = {
      fromMs: Date.parse('2023-11-14T22:13:00.000Z'),
      toMs: Date.parse('2023-11-14T22:14:00.000Z'),
    };
    await expect(probe.detect(gap)).resolves.toEqual({
      suspended: true,
      suspendStartedAt: Date.parse('2023-11-14T22:13:30.000Z'),
    });
  });

  it('win32: missing event log is not suspended', async () => {
    const probe = createHostSleepProbe({
      platform: 'win32',
      timeoutMs: 200,
      queryKernelPower: async () => {
        throw new Error('wevtutil: not found');
      },
    });
    await expect(probe.detect({
      fromMs: 1_700_000_000_000,
      toMs: 1_700_000_090_000,
    })).resolves.toEqual({ suspended: false });
  });

  it('linux: times out a hung /proc/uptime read as not suspended', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let hang = false;
    const probe = createHostSleepProbe({
      platform: 'linux',
      timeoutMs: HOST_SLEEP_PROBE_TIMEOUT_MS,
      readUptime: () => (hang ? new Promise<string>(() => {}) : Promise.resolve('1.00 0')),
      hrtime: () => 1n,
    });
    await probe.note(1);
    hang = true;
    const pending = probe.detect({ fromMs: 1, toMs: 60_000 });
    await vi.advanceTimersByTimeAsync(HOST_SLEEP_PROBE_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ suspended: false });
  });

  it('darwin: times out hung sysctl as not suspended', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const probe = createHostSleepProbe({
      platform: 'darwin',
      timeoutMs: HOST_SLEEP_PROBE_TIMEOUT_MS,
      sysctl: () => new Promise<string>(() => {}),
    });
    const pending = probe.detect({
      fromMs: 1_700_000_000_000,
      toMs: 1_700_000_090_000,
    });
    await vi.advanceTimersByTimeAsync(HOST_SLEEP_PROBE_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ suspended: false });
  });

  it('win32: times out a hung event log query as not suspended', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const probe = createHostSleepProbe({
      platform: 'win32',
      timeoutMs: HOST_SLEEP_PROBE_TIMEOUT_MS,
      queryKernelPower: () => new Promise<string>(() => {}),
    });
    const pending = probe.detect({
      fromMs: 1_700_000_000_000,
      toMs: 1_700_000_090_000,
    });
    await vi.advanceTimersByTimeAsync(HOST_SLEEP_PROBE_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ suspended: false });
  });
});
