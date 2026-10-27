import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CallbackAuth } from '../../../src/card/callback-auth.js';
import { CallbackNonceStore } from '../../../src/card/callback-store.js';

const cleanups: Array<() => Promise<void>> = [];

describe('CallbackAuth', () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  it('signs and verifies all callback context fields', async () => {
    const h = await harness();
    const token = h.auth.sign({
      runId: 'run-1',
      scope: 'chat-1',
      chatId: 'oc_1',
      operatorOpenId: 'ou_1',
      action: 'stop',
      policyFingerprint: 'fp-1',
      ttlMs: 60_000,
    });

    expect(
      h.auth.verify(token, {
        runId: 'run-1',
        scope: 'chat-1',
        chatId: 'oc_1',
        operatorOpenId: 'ou_1',
        action: 'stop',
        policyFingerprint: 'fp-1',
      }),
    ).toMatchObject({ ok: true });
  });

  it.each([
    ['runId', { runId: 'run-other' }],
    ['scope', { scope: 'chat-other' }],
    ['chatId', { chatId: 'oc_other' }],
    ['operator', { operatorOpenId: 'ou_other' }],
    ['action', { action: 'resume' }],
    ['policy fingerprint', { policyFingerprint: 'fp-other' }],
  ])('rejects mismatched %s', async (_label, override) => {
    const h = await harness();
    const token = h.auth.sign(baseSignInput());

    expect(
      h.auth.verify(token, {
        ...baseExpected(),
        ...override,
      }),
    ).toMatchObject({ ok: false });
  });
});

function baseSignInput() {
  return {
    runId: 'run-1',
    scope: 'chat-1',
    chatId: 'oc_1',
    operatorOpenId: 'ou_1',
    action: 'stop',
    policyFingerprint: 'fp-1',
    ttlMs: 60_000,
  };
}

function baseExpected() {
  return {
    runId: 'run-1',
    scope: 'chat-1',
    chatId: 'oc_1',
    operatorOpenId: 'ou_1',
    action: 'stop',
    policyFingerprint: 'fp-1',
  };
}

async function harness() {
  const storePath = await path();
  const store = new CallbackNonceStore(storePath);
  cleanups.push(() => store.flush());
  const auth = new CallbackAuth({
    keys: [{ version: 1, secret: 'secret-1' }],
    nonceStore: store,
    now: () => 1000,
    createNonce: () => 'nonce-1',
  });
  return {
    auth,
  };
}

async function path(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'callback-auth-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'nonces.json');
}
