import { randomUUID } from 'node:crypto';
import type { SessionCatalogIdentity } from './catalog';

interface ResumeCandidate extends SessionCatalogIdentity {
  resumeHandle: string;
  expiresAt: number;
}

const RESUME_CANDIDATE_TTL_MS = 10 * 60 * 1000;

/** One channel runtime owns these short-lived, single-attempt selections. */
export class ResumeCandidates {
  private readonly candidates = new Map<string, ResumeCandidate>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly createNonce: () => string = () => randomUUID().slice(0, 12),
  ) {}

  issue(identity: SessionCatalogIdentity, resumeHandle: string): string {
    this.prune();
    let nonce = this.createNonce();
    while (this.candidates.has(nonce)) nonce = this.createNonce();
    this.candidates.set(nonce, {
      scopeId: identity.scopeId,
      agentId: identity.agentId,
      cwdRealpath: identity.cwdRealpath,
      policyFingerprint: identity.policyFingerprint,
      resumeHandle,
      expiresAt: this.now() + RESUME_CANDIDATE_TTL_MS,
    });
    return nonce;
  }

  consume(nonce: string, identity: SessionCatalogIdentity): { resumeHandle: string } | undefined {
    this.prune();
    const candidate = this.candidates.get(nonce);
    if (!candidate) return undefined;
    this.candidates.delete(nonce);
    if (
      candidate.scopeId !== identity.scopeId ||
      candidate.agentId !== identity.agentId ||
      candidate.cwdRealpath !== identity.cwdRealpath ||
      candidate.policyFingerprint !== identity.policyFingerprint ||
      !candidate.resumeHandle
    ) return undefined;
    return { resumeHandle: candidate.resumeHandle };
  }

  clear(): void {
    this.candidates.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [nonce, candidate] of this.candidates) {
      if (candidate.expiresAt <= now) this.candidates.delete(nonce);
    }
  }
}
