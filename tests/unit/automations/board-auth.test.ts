import { describe, expect, it } from 'vitest';
import { BoardActionAuth } from '../../../src/automations/board-auth';

describe('BoardActionAuth', () => {
  it('signs chat+item+action without a nonce and accepts a second verify', () => {
    let now = 1000;
    const auth = new BoardActionAuth({ secret: 'board-secret', now: () => now });
    const token = auth.sign({
      chatId: 'oc_group',
      itemId: 3,
      action: 'auto.pause',
      ttlMs: 60_000,
    });
    expect(token).toMatch(/^auto_board\.v1\./);
    const encoded = token.split('.')[2]!;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(payload).toEqual({
      c: 'oc_group',
      i: 3,
      a: 'auto.pause',
      exp: 61_000,
    });
    expect(payload).not.toHaveProperty('n');
    expect(payload).not.toHaveProperty('o');

    expect(auth.verify(token)).toEqual({
      ok: true,
      payload: { chatId: 'oc_group', itemId: 3, action: 'auto.pause', exp: 61_000 },
    });
    expect(auth.verify(token)).toMatchObject({ ok: true, payload: { itemId: 3, action: 'auto.pause' } });

    const expired = auth.sign({
      chatId: 'oc_group',
      itemId: 3,
      action: 'auto.delete',
      ttlMs: 10,
    });
    now = 100_000;
    expect(auth.verify(expired)).toEqual({ ok: false, reason: 'expired' });

    const other = new BoardActionAuth({ secret: 'other-secret', now: () => 1000 });
    const forged = other.sign({
      chatId: 'oc_group',
      itemId: 3,
      action: 'auto.pause',
      ttlMs: 60_000,
    });
    now = 1000;
    expect(auth.verify(forged)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(auth.verify('auto_cb.v1.not-a-board')).toEqual({ ok: false, reason: 'malformed' });
  });
});
