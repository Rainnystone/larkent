import { afterEach, describe, expect, it } from 'vitest';
import { AutoActionAuth } from '../../../src/automations/action-auth';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('AutoActionAuth', () => {
  it('signs draft+chat+action without an operator and rejects replay, expiry, and forgery', async () => {
    const h = await harness();
    const token = h.auth.sign({
      draftId: 'draft-1',
      chatId: 'oc_group',
      action: 'auto.confirm',
      ttlMs: 60_000,
    });
    expect(token).toMatch(/^auto_cb\.v1\./);
    const encoded = token.split('.')[2]!;
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(payload).toEqual({
      d: 'draft-1',
      c: 'oc_group',
      a: 'auto.confirm',
      exp: 61_000,
      n: 'nonce-1',
    });
    expect(payload).not.toHaveProperty('o');
    expect(payload).not.toHaveProperty('r');

    expect(h.auth.verify(token)).toMatchObject({
      ok: true,
      payload: { draftId: 'draft-1', chatId: 'oc_group', action: 'auto.confirm' },
    });
    expect(h.auth.verify(token)).toMatchObject({ ok: false, reason: 'nonce-replay' });

    const expired = h.auth.sign({
      draftId: 'draft-2',
      chatId: 'oc_group',
      action: 'auto.confirm',
      ttlMs: 10,
    });
    h.setNow(100_000);
    expect(h.auth.verify(expired)).toMatchObject({ ok: false, reason: 'expired' });

    const other = new AutoActionAuth({
      secret: 'other-secret',
      nonceStore: h.store,
      now: () => 1000,
      createNonce: () => 'nonce-x',
    });
    const forged = other.sign({
      draftId: 'draft-1',
      chatId: 'oc_group',
      action: 'auto.confirm',
      ttlMs: 60_000,
    });
    h.setNow(1000);
    expect(h.auth.verify(forged)).toMatchObject({ ok: false, reason: 'bad-signature' });
  });
});

async function harness() {
  const tmp: TmpProfile = await createTmpProfile('auto-auth-');
  const store = new CallbackNonceStore(`${tmp.profile}/nonces.json`);
  let now = 1000;
  let n = 0;
  const auth = new AutoActionAuth({
    secret: 'auto-secret',
    nonceStore: store,
    now: () => now,
    createNonce: () => `nonce-${++n}`,
  });
  cleanups.push(async () => {
    await store.flush();
    await tmp.cleanup();
  });
  return {
    auth,
    store,
    setNow(next: number) {
      now = next;
    },
  };
}
