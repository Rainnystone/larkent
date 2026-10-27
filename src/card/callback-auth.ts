import {
  ActionTokenCodec,
  type ActionTokenInvalidReason,
  type ActionTokenKey,
  type ActionTokenOptions,
  type ActionTokenPurpose,
} from './action-token';
import type { CallbackNonceStore } from './callback-store';

export type CallbackKey = ActionTokenKey;
export interface CallbackAuthOptions extends ActionTokenOptions {
  nonceStore: CallbackNonceStore;
}

export interface CallbackVerifyExpected {
  runId: string;
  scope: string;
  chatId: string;
  operatorOpenId: string;
  action: string;
  policyFingerprint: string;
}

export interface CallbackSignInput extends CallbackVerifyExpected {
  ttlMs: number;
}

export interface CallbackPayload {
  r: string;
  s: string;
  c: string;
  o: string;
  a: string;
  exp: number;
  fp: string;
  n: string;
  kv: number;
}

export type CallbackVerifyResult =
  | { ok: true; payload: CallbackPayload }
  | { ok: false; reason: ActionTokenInvalidReason };

export const bridgeCallbackPurpose: ActionTokenPurpose<CallbackVerifyExpected> = {
  prefix: 'bridge_cb.v2',
  noncePolicy: 'consume-on-verify',
  parseClaims(value) {
    const raw = value as Partial<CallbackVerifyExpected> | null;
    if (!raw || typeof raw.runId !== 'string' || typeof raw.scope !== 'string'
      || typeof raw.chatId !== 'string' || typeof raw.operatorOpenId !== 'string'
      || typeof raw.action !== 'string' || typeof raw.policyFingerprint !== 'string') return undefined;
    return { runId: raw.runId, scope: raw.scope, chatId: raw.chatId,
      operatorOpenId: raw.operatorOpenId, action: raw.action, policyFingerprint: raw.policyFingerprint };
  },
};

export class CallbackAuth {
  private readonly codec: ActionTokenCodec;

  constructor(options: CallbackAuthOptions | ActionTokenCodec) {
    this.codec = options instanceof ActionTokenCodec ? options : new ActionTokenCodec(options);
  }

  sign({ ttlMs, ...claims }: CallbackSignInput): string {
    return this.codec.sign(bridgeCallbackPurpose, claims, ttlMs);
  }

  verify(token: string, expected: CallbackVerifyExpected): CallbackVerifyResult {
    const result = this.codec.verify(token, bridgeCallbackPurpose, expected);
    if (!result.ok) return result;
    const claims = result.claims;
    return { ok: true, payload: { r: claims.runId, s: claims.scope, c: claims.chatId,
      o: claims.operatorOpenId, a: claims.action, fp: claims.policyFingerprint,
      exp: result.exp, n: result.nonce!, kv: result.keyVersion } };
  }
}
