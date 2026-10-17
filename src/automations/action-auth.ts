import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CallbackNonceStore } from '../card/callback-store';
import { AUTOMATIONS_DRAFT_TTL_MS } from './store';

export type AutoCardAction = 'auto.confirm' | 'auto.reject';

export interface AutoSignInput {
  draftId: string;
  chatId: string;
  action: AutoCardAction;
  ttlMs: number;
}

export interface AutoPayload {
  draftId: string;
  chatId: string;
  action: AutoCardAction;
  exp: number;
  nonce: string;
}

export type AutoVerifyResult =
  | { ok: true; payload: AutoPayload }
  | {
      ok: false;
      reason: 'malformed' | 'bad-signature' | 'expired' | 'nonce-replay' | 'nonce-revoked';
    };

const PREFIX = 'auto_cb.v1';

export const AUTO_CARD_TTL_MS = AUTOMATIONS_DRAFT_TTL_MS;

export class AutoActionAuth {
  private readonly secret: string;
  private readonly nonceStore: CallbackNonceStore;
  private readonly now: () => number;
  private readonly createNonce: () => string;

  constructor(options: {
    secret: string;
    nonceStore: CallbackNonceStore;
    now?: () => number;
    createNonce?: () => string;
  }) {
    this.secret = options.secret;
    this.nonceStore = options.nonceStore;
    this.now = options.now ?? Date.now;
    this.createNonce = options.createNonce ?? (() => randomBytes(16).toString('base64url'));
  }

  sign(input: AutoSignInput): string {
    const payload = {
      d: input.draftId,
      c: input.chatId,
      a: input.action,
      exp: this.now() + input.ttlMs,
      n: this.createNonce(),
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${PREFIX}.${encoded}.${sign(encoded, this.secret)}`;
  }

  verify(token: string): AutoVerifyResult {
    const parts = token.split('.');
    if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== PREFIX) {
      return { ok: false, reason: 'malformed' };
    }
    const encoded = parts[2];
    const signature = parts[3];
    if (!encoded || !signature) return { ok: false, reason: 'malformed' };
    if (!signatureMatches(signature, sign(encoded, this.secret))) {
      return { ok: false, reason: 'bad-signature' };
    }
    const payload = decodePayload(encoded);
    if (!payload) return { ok: false, reason: 'malformed' };
    if (payload.exp <= this.now()) return { ok: false, reason: 'expired' };
    const nonceState = this.nonceStore.state(payload.nonce);
    if (nonceState === 'revoked') return { ok: false, reason: 'nonce-revoked' };
    if (nonceState === 'used') return { ok: false, reason: 'nonce-replay' };
    if (!this.nonceStore.consume(payload.nonce)) return { ok: false, reason: 'nonce-replay' };
    return { ok: true, payload };
  }
}

function decodePayload(encoded: string): AutoPayload | undefined {
  try {
    const raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      typeof raw.d !== 'string'
      || typeof raw.c !== 'string'
      || (raw.a !== 'auto.confirm' && raw.a !== 'auto.reject')
      || typeof raw.exp !== 'number'
      || typeof raw.n !== 'string'
    ) {
      return undefined;
    }
    return {
      draftId: raw.d,
      chatId: raw.c,
      action: raw.a,
      exp: raw.exp,
      nonce: raw.n,
    };
  } catch {
    return undefined;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function signatureMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes)
  );
}
