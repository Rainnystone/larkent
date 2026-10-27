import { afterEach, describe, expect, it } from 'vitest';
import { AutoActionAuth } from '../../../src/automations/action-auth';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('AutoActionAuth', () => {
  it('returns draft, chat and action claims without binding an operator', async () => {
    const h = await harness();
    const token = h.auth.sign({ draftId: 'draft-1', chatId: 'group', action: 'auto.confirm', ttlMs: 60_000 });
    expect(h.auth.verify(token)).toEqual({ ok: true, payload: {
      draftId: 'draft-1', chatId: 'group', action: 'auto.confirm', exp: 61_000, nonce: 'nonce-1',
    } });
  });

});

async function harness() {
  const tmp: TmpProfile = await createTmpProfile('auto-auth-');
  const store = new CallbackNonceStore(`${tmp.profile}/nonces.json`);
  let n = 0;
  const auth = new AutoActionAuth({
    secret: 'auto-secret',
    nonceStore: store,
    now: () => 1000,
    createNonce: () => `nonce-${++n}`,
  });
  cleanups.push(async () => {
    await store.flush();
    await tmp.cleanup();
  });
  return {
    auth,
  };
}
