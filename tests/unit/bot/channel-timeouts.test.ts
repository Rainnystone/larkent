import { describe, expect, it } from 'vitest';
import {
  CHANNEL_CONNECT_TIMEOUT_MS,
  CHANNEL_HANDSHAKE_TIMEOUT_MS,
} from '../../../src/bot/channel';

describe('Channel reconnect timeouts', () => {
  it('keeps handshake and connect budgets the same 8s fast-fail', () => {
    expect(CHANNEL_HANDSHAKE_TIMEOUT_MS).toBe(8_000);
    expect(CHANNEL_CONNECT_TIMEOUT_MS).toBe(CHANNEL_HANDSHAKE_TIMEOUT_MS);
  });
});
