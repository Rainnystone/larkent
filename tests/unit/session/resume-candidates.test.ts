import { describe, expect, it } from 'vitest';
import { ResumeCandidates } from '../../../src/session/resume-candidates.js';
import type { SessionCatalogIdentity } from '../../../src/session/catalog.js';

const identity: SessionCatalogIdentity = {
  scopeId: 'same-chat', agentId: 'kimi', cwdRealpath: '/same', policyFingerprint: 'same',
};

describe('ResumeCandidates', () => {
  it('isolates identical identities and consumes only once in the owning instance', () => {
    const a = new ResumeCandidates(() => 1000, () => 'nonce-a');
    const b = new ResumeCandidates(() => 1000, () => 'nonce-b');
    const nonce = a.issue(identity, 'handle-a');
    expect(b.consume(nonce, identity)).toBeUndefined();
    expect(a.consume(nonce, identity)).toEqual({ resumeHandle: 'handle-a' });
    expect(a.consume(nonce, identity)).toBeUndefined();
  });

  it.each([
    { scopeId: 'other-chat' }, { agentId: 'grok' as const },
    { cwdRealpath: '/other' }, { policyFingerprint: 'other' },
  ])('rejects identity mismatch %j and spends that same-instance attempt', (change) => {
    const candidates = new ResumeCandidates();
    const nonce = candidates.issue(identity, 'handle');
    expect(candidates.consume(nonce, { ...identity, ...change })).toBeUndefined();
    expect(candidates.consume(nonce, identity)).toBeUndefined();
  });

  it('rejects an empty handle', () => {
    const candidates = new ResumeCandidates();
    expect(candidates.consume(candidates.issue(identity, ''), identity)).toBeUndefined();
  });

  it.each([599_999, 600_000, 600_001])('expires at the ten-minute boundary: %i ms', (elapsed) => {
    let now = 1000;
    const candidates = new ResumeCandidates(() => now);
    const nonce = candidates.issue(identity, 'handle');
    now += elapsed;
    expect(candidates.consume(nonce, identity)).toEqual(elapsed < 600_000 ? { resumeHandle: 'handle' } : undefined);
  });

  it('clears only its own candidates', () => {
    const a = new ResumeCandidates();
    const b = new ResumeCandidates();
    const nonceA = a.issue(identity, 'a');
    const nonceB = b.issue(identity, 'b');
    a.clear();
    expect(a.consume(nonceA, identity)).toBeUndefined();
    expect(b.consume(nonceB, identity)).toEqual({ resumeHandle: 'b' });
  });

  it('retries live nonce collisions without overwriting the first candidate', () => {
    const nonces = ['collision', 'collision', 'next'];
    const candidates = new ResumeCandidates(() => 1000, () => nonces.shift()!);
    const first = candidates.issue(identity, 'first');
    const second = candidates.issue(identity, 'second');
    expect(second).toBe('next');
    expect(candidates.consume(first, identity)).toEqual({ resumeHandle: 'first' });
    expect(candidates.consume(second, identity)).toEqual({ resumeHandle: 'second' });
  });

  it('prunes expired candidates before issuing another nonce', () => {
    let now = 1000;
    const nonces = ['same-nonce', 'same-nonce', 'fallback'];
    const candidates = new ResumeCandidates(() => now, () => nonces.shift()!);
    candidates.issue(identity, 'expired');
    now += 600_000;
    const nonce = candidates.issue(identity, 'fresh');
    expect(nonce).toBe('same-nonce');
    expect(candidates.consume(nonce, identity)).toEqual({ resumeHandle: 'fresh' });
  });

  it('keeps the default twelve-character UUID prefix format', () => {
    expect(new ResumeCandidates().issue(identity, 'handle')).toMatch(/^[a-f0-9]{8}-[a-f0-9]{3}$/);
  });
});
