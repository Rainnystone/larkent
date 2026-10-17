import { createHmac, timingSafeEqual } from 'node:crypto';

export type BoardCardAction = 'auto.pause' | 'auto.resume' | 'auto.delete';

export interface BoardSignInput {
  chatId: string;
  itemId: number;
  action: BoardCardAction;
  ttlMs: number;
}

export interface BoardPayload {
  chatId: string;
  itemId: number;
  action: BoardCardAction;
  exp: number;
}

export type BoardVerifyResult =
  | { ok: true; payload: BoardPayload }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' };

const PREFIX = 'auto_board.v1';

/** Covers the 1-year schedule cap so a board that is not re-rendered still accepts taps. */
export const BOARD_CARD_TTL_MS = 400 * 24 * 60 * 60 * 1000;

export class BoardActionAuth {
  private readonly secret: string;
  private readonly now: () => number;

  constructor(options: { secret: string; now?: () => number }) {
    this.secret = options.secret;
    this.now = options.now ?? Date.now;
  }

  sign(input: BoardSignInput): string {
    const payload = {
      c: input.chatId,
      i: input.itemId,
      a: input.action,
      exp: this.now() + input.ttlMs,
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${PREFIX}.${encoded}.${sign(encoded, this.secret)}`;
  }

  verify(token: string): BoardVerifyResult {
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
    return { ok: true, payload };
  }
}

function decodePayload(encoded: string): BoardPayload | undefined {
  try {
    const raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      typeof raw.c !== 'string'
      || typeof raw.i !== 'number'
      || !Number.isInteger(raw.i)
      || raw.i < 1
      || (raw.a !== 'auto.pause' && raw.a !== 'auto.resume' && raw.a !== 'auto.delete')
      || typeof raw.exp !== 'number'
    ) {
      return undefined;
    }
    return {
      chatId: raw.c,
      itemId: raw.i,
      action: raw.a,
      exp: raw.exp,
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
