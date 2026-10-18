import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('channel wake reconnect patch', () => {
  it('hands a keepalive wake-up to onWake and watches inbound frames', () => {
    for (const file of ['dist/index.mjs', 'dist/index.cjs']) {
      const source = readFileSync(`node_modules/@larksuite/channel/${file}`, 'utf8');
      const wakeAt = source.indexOf('channel: keepalive wake-up');
      expect(wakeAt, file).toBeGreaterThan(-1);
      const wake = source.slice(wakeAt, wakeAt + 800);
      expect(wake, file).toContain('onWake()');
      expect(wake, file).not.toMatch(/lastTick = now;\s*return;/);
      expect(source, file).toContain('watchInboundFrames');
      expect(source, file).toContain('onSocketFrame');
      expect(source, file).toContain('this.rawWsClient !== client');
      expect(source, file).not.toContain('forceReconnectInFlight');
    }
  });
});
