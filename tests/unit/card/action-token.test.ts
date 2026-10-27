import { afterEach, describe, expect, it } from 'vitest';
import { ActionTokenCodec, type ActionTokenPurpose } from '../../../src/card/action-token';
import { CallbackNonceStore } from '../../../src/card/callback-store';
import { bridgeCallbackPurpose } from '../../../src/card/callback-auth';
import { noticeActionPurpose } from '../../../src/bot/interruption-notice';
import { boardActionPurpose } from '../../../src/automations/board-auth';
import { autoActionPurpose } from '../../../src/automations/action-auth';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Claims { scope: string; turnId: string; policyFingerprint: string }
const purpose: ActionTokenPurpose<Claims> = {
  prefix: 'test_action.v2',
  noncePolicy: 'consume-on-verify',
  parseClaims(value) {
    const raw = value as Partial<Claims> | null;
    return raw && typeof raw.scope === 'string' && typeof raw.turnId === 'string'
      && typeof raw.policyFingerprint === 'string'
      ? { scope: raw.scope, turnId: raw.turnId, policyFingerprint: raw.policyFingerprint }
      : undefined;
  },
};
const claims: Claims = { scope: 'group:topic', turnId: 'turn-1', policyFingerprint: 'policy-1' };

describe('action token codec', () => {
  it('round trips automation confirmation claims and defers consumption', async () => {
    const h = await harness();
    const confirmation = { draftId: 'draft-1', chatId: 'group', action: 'auto.confirm' as const };
    const token = h.codec.sign(autoActionPurpose, confirmation, 100);
    expect(h.codec.verify(token, autoActionPurpose, confirmation)).toMatchObject({ ok: true, claims: confirmation });
    expect(h.codec.verify(token, autoActionPurpose, confirmation)).toMatchObject({ ok: true });
  });

  it.each<ActionTokenPurpose<object>>([
    bridgeCallbackPurpose, noticeActionPurpose, autoActionPurpose, boardActionPurpose,
  ])('rejects authenticated claims outside the schema of $prefix', async (declaredPurpose) => {
    const h = await harness();
    const token = h.codec.sign(declaredPurpose, {}, 100);
    expect(h.codec.verify(token, declaredPurpose)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('round trips a reusable board action and enforces its chat context', async () => {
    const h = await harness();
    const board = { chatId: 'group', itemId: 3, action: 'auto.pause' as const };
    const token = h.codec.sign(boardActionPurpose, board, 100);
    expect(h.codec.verify(token, boardActionPurpose, { chatId: 'another-group' }))
      .toEqual({ ok: false, reason: 'context-mismatch' });
    expect(h.codec.verify(token, boardActionPurpose)).toMatchObject({ ok: true, claims: board });
    expect(h.codec.verify(token, boardActionPurpose)).toMatchObject({ ok: true, claims: board });
  });

  it('binds notice claims to turn, scope and policy without binding the clicker', async () => {
    const h = await harness();
    const notice = { turnId: 'turn-1', scope: 'group:topic', chatId: 'group',
      action: 'notice.continue' as const, policyFingerprint: 'policy-1' };
    const token = h.codec.sign(noticeActionPurpose, notice, 100);
    expect(h.codec.verify(token, noticeActionPurpose, { turnId: 'other-turn' }))
      .toEqual({ ok: false, reason: 'context-mismatch' });
    expect(h.codec.verify(token, noticeActionPurpose, notice)).toMatchObject({ ok: true, claims: notice });
  });

  it('round trips bridge callback claims through its declared purpose', async () => {
    const h = await harness();
    const callback = { runId: 'run-1', scope: 'group:topic', chatId: 'group',
      operatorOpenId: 'operator', action: 'stop', policyFingerprint: 'policy-1' };
    const token = h.codec.sign(bridgeCallbackPurpose, callback, 100);
    expect(h.codec.verify(token, bridgeCallbackPurpose, callback)).toMatchObject({ ok: true, claims: callback });
  });

  it('round trips typed claims and expires at the TTL boundary', async () => {
    const h = await harness();
    const token = h.codec.sign(purpose, claims, 100);
    expect(h.codec.verify(token, purpose, claims)).toMatchObject({ ok: true, claims, exp: 1100 });
    h.setNow(1100);
    expect(h.codec.verify(token, purpose, claims)).toEqual({ ok: false, reason: 'expired' });
  });

  it.each([
    { scope: 'other-topic' }, { turnId: 'other-turn' }, { policyFingerprint: 'changed-policy' },
  ])('rejects mismatched context without consuming the token: %j', async (context) => {
    const h = await harness();
    const token = h.codec.sign(purpose, claims, 100);
    expect(h.codec.verify(token, purpose, context)).toEqual({ ok: false, reason: 'context-mismatch' });
    expect(h.codec.verify(token, purpose, claims)).toMatchObject({ ok: true });
  });

  it('consumes on verify and rejects replay after nonce-store reload', async () => {
    const h = await harness();
    const token = h.codec.sign(purpose, claims, 100);
    expect(h.codec.verify(token, purpose)).toMatchObject({ ok: true });
    expect(h.codec.verify(token, purpose)).toEqual({ ok: false, reason: 'nonce-replay' });
    await h.store.flush();
    const reloaded = new CallbackNonceStore(h.storePath);
    await reloaded.load();
    const restarted = new ActionTokenCodec({ keys: [{ version: 1, secret: 'test-secret' }],
      nonceStore: reloaded, now: () => 1000 });
    expect(restarted.verify(token, purpose)).toEqual({ ok: false, reason: 'nonce-replay' });
  });

  it('keeps deferred validation retryable, allows one claimant, then consumes explicitly', async () => {
    const h = await harness();
    const deferred = { ...purpose, noncePolicy: 'deferred' as const };
    const token = h.codec.sign(deferred, claims, 100);
    const verified = h.codec.verify(token, deferred);
    expect(verified.ok).toBe(true);
    if (!verified.ok || !verified.nonce) throw new Error('expected a deferred nonce');
    const nonce = verified.nonce;
    expect(h.codec.verify(token, deferred)).toMatchObject({ ok: true });
    expect(await Promise.all([Promise.resolve().then(() => h.codec.claim(nonce)),
      Promise.resolve().then(() => h.codec.claim(nonce))])).toEqual([true, false]);
    h.codec.release(nonce);
    expect(h.codec.claim(nonce)).toBe(true);
    expect(h.codec.consume(nonce)).toBe(true);
    h.codec.release(nonce);
    expect(h.codec.claim(nonce)).toBe(false);
    expect(h.codec.consume(nonce)).toBe(false);
    expect(h.codec.verify(token, deferred)).toEqual({ ok: false, reason: 'nonce-replay' });
  });

  it('distinguishes revocation from replay and refuses revoked claims', async () => {
    const h = await harness();
    const token = h.codec.sign(purpose, claims, 100);
    h.store.revoke('nonce-1');
    expect(h.codec.verify(token, purpose)).toEqual({ ok: false, reason: 'nonce-revoked' });
    expect(h.codec.claim('nonce-1')).toBe(false);
  });

  it('allows reusable actions without a nonce store or nonce generation', () => {
    const reusable = { ...purpose, noncePolicy: 'none' as const };
    const codec = new ActionTokenCodec({ keys: [{ version: 1, secret: 'test-secret' }],
      now: () => 1000, createNonce: () => { throw new Error('reusable action requested a nonce'); } });
    const token = codec.sign(reusable, claims, 100);
    expect(codec.verify(token, reusable)).toMatchObject({ ok: true, claims });
    expect(codec.verify(token, reusable)).toMatchObject({ ok: true, claims });
    expect(codec.verify(token, reusable)).not.toHaveProperty('nonce');
  });

  it('verifies the previous key but signs only with the newest active key', async () => {
    const h = await harness();
    const rotated = new ActionTokenCodec({ keys: [
      { version: 3, secret: 'future-retired', retired: true },
      { version: 2, secret: 'new-secret' }, { version: 1, secret: 'test-secret', retired: true },
    ], nonceStore: h.store, now: () => 1000 });
    const oldToken = h.codec.sign(purpose, claims, 100);
    expect(rotated.verify(oldToken, purpose)).toMatchObject({ ok: true, keyVersion: 1 });
    const newToken = rotated.sign(purpose, claims, 100);
    const currentOnly = new ActionTokenCodec({ keys: [{ version: 2, secret: 'new-secret' }],
      nonceStore: h.store, now: () => 1000 });
    expect(h.codec.verify(newToken, purpose)).toEqual({ ok: false, reason: 'unknown-key' });
    expect(currentOnly.verify(newToken, purpose)).toMatchObject({ ok: true, keyVersion: 2 });
  });

  it('rejects another purpose, including a rewritten prefix with the same claims and key', async () => {
    const h = await harness();
    const token = h.codec.sign(purpose, claims, 100);
    const other = { ...purpose, prefix: 'other_action.v2' };
    expect(h.codec.verify(token, other)).toEqual({ ok: false, reason: 'wrong-purpose' });
    expect(h.codec.verify(token.replace(purpose.prefix, other.prefix), other))
      .toEqual({ ok: false, reason: 'bad-signature' });
  });

  it.each(['payload', 'signature'] as const)('rejects a tampered %s without spending the original token', async (part) => {
    const h = await harness();
    const token = h.codec.sign(purpose, claims, 100);
    const parts = token.split('.');
    if (part === 'payload') {
      const payload = JSON.parse(Buffer.from(parts[2]!, 'base64url').toString());
      payload.claims.scope = 'another-scope';
      parts[2] = Buffer.from(JSON.stringify(payload)).toString('base64url');
    } else {
      parts[3] = `${parts[3]![0] === 'A' ? 'B' : 'A'}${parts[3]!.slice(1)}`;
    }
    expect(h.codec.verify(parts.join('.'), purpose)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(h.codec.verify(token, purpose)).toMatchObject({ ok: true });
  });

  it.each(['', 'test_action.v2', 'test_action.v2..sig', 'test_action.v2.bm90LWpzb24.sig',
    'test_action.v2.bnVsbA.sig', 'test_action.v2.e30.sig'])('returns a typed reason for malformed input %j', async (token) => {
    const h = await harness();
    expect(h.codec.verify(token, purpose)).toEqual({ ok: false, reason: 'malformed' });
  });
});

async function harness() {
  const tmp = await createTmpProfile('action-token-');
  const storePath = `${tmp.profile}/nonces.json`;
  const store = new CallbackNonceStore(storePath);
  let now = 1000;
  let sequence = 0;
  cleanups.push(() => tmp.cleanup(), () => store.flush());
  const codec = new ActionTokenCodec({
    keys: [{ version: 1, secret: 'test-secret' }], nonceStore: store,
    now: () => now, createNonce: () => `nonce-${++sequence}`,
  });
  return { codec, store, storePath, setNow: (next: number) => { now = next; } };
}
