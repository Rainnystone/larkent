import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_CONNECT_TIMEOUT_MS,
  CHANNEL_HANDSHAKE_TIMEOUT_MS,
  WS_DEFAULT_DEAD_LINK_DETECT_BOUND_SEC,
  WS_PING_TIMEOUT_SEC,
  WS_SERVER_PING_INTERVAL_SEC,
} from '../../../src/bot/channel';

/** Shorter PingInterval described in field reports. The next ping resets the watchdog. */
const SHORTER_REPORTED_PING_INTERVAL_SEC = 30;

describe('Channel reconnect timeouts', () => {
  it('keeps handshake and connect budgets the same 8s fast-fail', () => {
    expect(CHANNEL_HANDSHAKE_TIMEOUT_MS).toBe(8_000);
    expect(CHANNEL_CONNECT_TIMEOUT_MS).toBe(CHANNEL_HANDSHAKE_TIMEOUT_MS);
  });
});

describe('WS liveness watchdog', () => {
  it('waits 15s after a ping so routine jitter does not tear a healthy link down', () => {
    expect(WS_PING_TIMEOUT_SEC).toBe(15);
    expect(WS_PING_TIMEOUT_SEC).toBeLessThan(SHORTER_REPORTED_PING_INTERVAL_SEC);
    expect(WS_PING_TIMEOUT_SEC).toBeLessThan(WS_SERVER_PING_INTERVAL_SEC);
  });

  it('still detects a silent link within one default ping interval plus that wait', () => {
    expect(WS_SERVER_PING_INTERVAL_SEC).toBe(120);
    expect(WS_DEFAULT_DEAD_LINK_DETECT_BOUND_SEC).toBe(135);
    expect(WS_DEFAULT_DEAD_LINK_DETECT_BOUND_SEC).toBe(
      WS_SERVER_PING_INTERVAL_SEC + WS_PING_TIMEOUT_SEC,
    );
    expect(SHORTER_REPORTED_PING_INTERVAL_SEC + WS_PING_TIMEOUT_SEC).toBe(45);
  });

  it('configures the SDK with that timeout', () => {
    const channel = readFileSync(join(process.cwd(), 'src/bot/channel.ts'), 'utf8');
    expect(channel).toContain('pingTimeout: WS_PING_TIMEOUT_SEC');
    expect(channel).not.toMatch(/pingTimeout:\s*3\b/);
  });
});
