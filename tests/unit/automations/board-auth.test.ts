import { describe, expect, it } from 'vitest';
import { BoardActionAuth } from '../../../src/automations/board-auth';

describe('BoardActionAuth', () => {
  it('returns the board item, chat and action without binding an operator', () => {
    const auth = new BoardActionAuth({ secret: 'board-secret', now: () => 1000 });
    const token = auth.sign({ chatId: 'group', itemId: 3, action: 'auto.pause', ttlMs: 60_000 });
    expect(auth.verify(token)).toEqual({ ok: true,
      payload: { chatId: 'group', itemId: 3, action: 'auto.pause', exp: 61_000 } });
  });
});
