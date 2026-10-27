import { ActionTokenCodec, type ActionTokenInvalidReason, type ActionTokenPurpose } from '../card/action-token';

export type BoardCardAction = 'auto.pause' | 'auto.resume' | 'auto.delete';

export interface BoardSignInput {
  chatId: string;
  itemId: number;
  action: BoardCardAction;
  ttlMs: number;
}

type BoardClaims = Omit<BoardSignInput, 'ttlMs'>;
export interface BoardPayload extends BoardClaims { exp: number }
export type BoardVerifyResult =
  | { ok: true; payload: BoardPayload }
  | { ok: false; reason: ActionTokenInvalidReason };

/** Covers the 1-year schedule cap so a board that is not re-rendered still accepts taps. */
export const BOARD_CARD_TTL_MS = 400 * 24 * 60 * 60 * 1000;

export const boardActionPurpose: ActionTokenPurpose<BoardClaims> = {
  prefix: 'auto_board.v2',
  noncePolicy: 'none',
  parseClaims(value) {
    const raw = value as Partial<BoardClaims> | null;
    if (!raw || typeof raw.chatId !== 'string' || typeof raw.itemId !== 'number'
      || !Number.isInteger(raw.itemId) || raw.itemId < 1
      || (raw.action !== 'auto.pause' && raw.action !== 'auto.resume' && raw.action !== 'auto.delete')) return undefined;
    return { chatId: raw.chatId, itemId: raw.itemId, action: raw.action };
  },
};

export class BoardActionAuth {
  private readonly codec: ActionTokenCodec;

  constructor(options: ActionTokenCodec | { secret: string; now?: () => number }) {
    this.codec = options instanceof ActionTokenCodec ? options : new ActionTokenCodec({
      ...options, keys: [{ version: 1, secret: options.secret }],
    });
  }

  sign({ ttlMs, ...claims }: BoardSignInput): string {
    return this.codec.sign(boardActionPurpose, claims, ttlMs);
  }

  verify(token: string, context: Partial<BoardClaims> = {}): BoardVerifyResult {
    const result = this.codec.verify(token, boardActionPurpose, context);
    if (!result.ok) return result;
    return { ok: true, payload: { ...result.claims, exp: result.exp } };
  }
}
