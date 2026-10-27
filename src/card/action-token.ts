import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CallbackNonceStore } from './callback-store';

export type NoncePolicy = 'none' | 'consume-on-verify' | 'deferred';

export interface ActionTokenPurpose<Claims extends object> {
  prefix: string;
  noncePolicy: NoncePolicy;
  parseClaims(value: unknown): Claims | undefined;
}

export interface ActionTokenKey {
  version: number;
  secret: string;
  retired?: boolean;
}

export interface ActionTokenOptions {
  keys: ActionTokenKey[];
  nonceStore?: CallbackNonceStore;
  now?: () => number;
  createNonce?: () => string;
}

export type ActionTokenInvalidReason =
  | 'malformed' | 'wrong-purpose' | 'unknown-key' | 'bad-signature'
  | 'expired' | 'context-mismatch' | 'nonce-replay' | 'nonce-revoked';

export type ActionTokenResult<Claims> =
  | { ok: true; claims: Claims; exp: number; nonce?: string; keyVersion: number }
  | { ok: false; reason: ActionTokenInvalidReason };

export class ActionTokenCodec {
  private readonly keys: ActionTokenKey[];
  private readonly now: () => number;
  private readonly createNonce: () => string;
  private readonly claimedNonces = new Set<string>();

  constructor(private readonly options: ActionTokenOptions) {
    this.keys = [...options.keys].sort((a, b) => a.version - b.version);
    if (!this.keys.length) throw new Error('at least one action token key is required');
    this.now = options.now ?? Date.now;
    this.createNonce = options.createNonce ?? (() => randomBytes(16).toString('base64url'));
  }

  sign<Claims extends object>(purpose: ActionTokenPurpose<Claims>, claims: Claims, ttlMs: number): string {
    const key = this.keys.filter((candidate) => !candidate.retired).at(-1);
    if (!key) throw new Error('no active action token signing key');
    const encoded = Buffer.from(JSON.stringify({
      claims, exp: this.now() + ttlMs, kv: key.version,
      ...(purpose.noncePolicy !== 'none' ? { n: this.createNonce() } : {}),
    })).toString('base64url');
    const signed = `${purpose.prefix}.${encoded}`;
    return `${signed}.${mac(signed, key.secret)}`;
  }

  verify<Claims extends object>(
    token: string, purpose: ActionTokenPurpose<Claims>, context: Partial<Claims> = {},
  ): ActionTokenResult<Claims> {
    const parts = token.split('.');
    if (parts.length !== 4) return { ok: false, reason: 'malformed' };
    if (`${parts[0]}.${parts[1]}` !== purpose.prefix) return { ok: false, reason: 'wrong-purpose' };
    const encoded = parts[2];
    const signature = parts[3];
    if (!encoded || !signature) return { ok: false, reason: 'malformed' };
    try {
      const raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
      if (!raw || typeof raw.exp !== 'number' || !Number.isFinite(raw.exp)
        || typeof raw.kv !== 'number') return { ok: false, reason: 'malformed' };
      const key = this.keys.find((candidate) => candidate.version === raw.kv);
      if (!key) return { ok: false, reason: 'unknown-key' };
      const actual = Buffer.from(signature);
      const expected = Buffer.from(mac(`${purpose.prefix}.${encoded}`, key.secret));
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return { ok: false, reason: 'bad-signature' };
      }
      if (raw.exp <= this.now()) return { ok: false, reason: 'expired' };
      const claims = purpose.parseClaims(raw.claims);
      if (!claims) return { ok: false, reason: 'malformed' };
      if ((Object.keys(context) as Array<keyof Claims>).some((field) => claims[field] !== context[field])) {
        return { ok: false, reason: 'context-mismatch' };
      }
      if (purpose.noncePolicy !== 'none') {
        if (typeof raw.n !== 'string' || !raw.n || !this.options.nonceStore) {
          return { ok: false, reason: 'malformed' };
        }
        if (this.options.nonceStore.state(raw.n) === 'revoked') {
          return { ok: false, reason: 'nonce-revoked' };
        }
        if (this.options.nonceStore.state(raw.n) === 'used') {
          return { ok: false, reason: 'nonce-replay' };
        }
        if (purpose.noncePolicy === 'consume-on-verify' && !this.options.nonceStore.consume(raw.n)) {
          return { ok: false, reason: 'nonce-replay' };
        }
      }
      return { ok: true, claims, exp: raw.exp, keyVersion: key.version,
        ...(typeof raw.n === 'string' ? { nonce: raw.n } : {}) };
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  }

  /** Claims are in-flight only: a validation failure may release and retry. */
  claim(nonce: string): boolean {
    if (!this.options.nonceStore || this.options.nonceStore.state(nonce) !== undefined
      || this.claimedNonces.has(nonce)) return false;
    this.claimedNonces.add(nonce);
    return true;
  }

  release(nonce: string): void {
    this.claimedNonces.delete(nonce);
  }

  consume(nonce: string): boolean {
    return this.options.nonceStore?.consume(nonce) ?? false;
  }
}

function mac(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}
