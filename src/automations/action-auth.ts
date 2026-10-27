import { ActionTokenCodec, type ActionTokenInvalidReason, type ActionTokenPurpose } from '../card/action-token';
import type { CallbackNonceStore } from '../card/callback-store';
import { AUTOMATIONS_DRAFT_TTL_MS } from './store';

export const AUTO_CARD_ACTIONS = [
  'auto.confirm',
  'auto.reject',
  'auto.end.1w',
  'auto.end.2w',
  'auto.end.1m',
  'auto.end.3m',
  'auto.end.eoy',
  'auto.end.1y',
  'auto.end.custom',
] as const;

export type AutoCardAction = (typeof AUTO_CARD_ACTIONS)[number];

export function isAutoCardAction(value: string): value is AutoCardAction {
  return (AUTO_CARD_ACTIONS as readonly string[]).includes(value);
}

export type AutoEndAction = Extract<AutoCardAction, `auto.end.${string}`>;

export function isAutoEndAction(action: AutoCardAction): action is AutoEndAction {
  switch (action) {
    case 'auto.end.1w':
    case 'auto.end.2w':
    case 'auto.end.1m':
    case 'auto.end.3m':
    case 'auto.end.eoy':
    case 'auto.end.1y':
    case 'auto.end.custom':
      return true;
    case 'auto.confirm':
    case 'auto.reject':
      return false;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

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

type AutoClaims = Omit<AutoSignInput, 'ttlMs'>;

export type AutoVerifyResult =
  | { ok: true; payload: AutoPayload }
  | { ok: false; reason: ActionTokenInvalidReason };

export const AUTO_CARD_TTL_MS = AUTOMATIONS_DRAFT_TTL_MS;

export const autoActionPurpose: ActionTokenPurpose<AutoClaims> = {
  prefix: 'auto_cb.v2',
  noncePolicy: 'deferred',
  parseClaims(value) {
    const raw = value as Partial<AutoClaims> | null;
    if (!raw || typeof raw.draftId !== 'string' || typeof raw.chatId !== 'string'
      || typeof raw.action !== 'string' || !isAutoCardAction(raw.action)) return undefined;
    return { draftId: raw.draftId, chatId: raw.chatId, action: raw.action };
  },
};

export class AutoActionAuth {
  private readonly codec: ActionTokenCodec;

  constructor(options: ActionTokenCodec | {
    secret: string;
    nonceStore: CallbackNonceStore;
    now?: () => number;
    createNonce?: () => string;
  }) {
    this.codec = options instanceof ActionTokenCodec ? options : new ActionTokenCodec({
      ...options, keys: [{ version: 1, secret: options.secret }],
    });
  }

  sign({ ttlMs, ...claims }: AutoSignInput): string {
    return this.codec.sign(autoActionPurpose, claims, ttlMs);
  }

  verify(token: string, context: Partial<AutoClaims> = {}): AutoVerifyResult {
    const result = this.codec.verify(token, autoActionPurpose, context);
    if (!result.ok) return result;
    return { ok: true, payload: { ...result.claims, exp: result.exp, nonce: result.nonce! } };
  }

  consume(nonce: string): boolean { return this.codec.consume(nonce); }
  claimNonce(nonce: string): boolean { return this.codec.claim(nonce); }
  releaseNonce(nonce: string): void { this.codec.release(nonce); }
}
