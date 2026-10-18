import type { LarkChannel } from '@larksuite/channel';
import { withOutboundTimeout } from '../bot/self-message';

export class CardKitApiError extends Error {
  readonly code: number;
  readonly msg: string;

  constructor(code: number, msg: string) {
    super(msg);
    this.name = 'CardKitApiError';
    this.code = code;
    this.msg = msg;
  }
}

/** Full replace via `cardkit.v1.card.update`. Throws when Feishu `code != 0`. */
export async function updateCardByCardId(
  channel: LarkChannel,
  cardId: string,
  card: object,
  sequence: number,
): Promise<void> {
  const update = cardUpdate(channel);
  if (!update) {
    throw new Error('cardkit.card.update is unavailable');
  }
  const res = await withOutboundTimeout(
    'cardkit.card.update',
    update({
      path: { card_id: cardId },
      data: {
        card: {
          type: 'card_json',
          data: JSON.stringify(card),
        },
        sequence,
        uuid: `u_${cardId}_${sequence}`,
      },
    }),
  );
  const rec = isRecord(res) ? res : undefined;
  const code = rec?.code;
  if (code === 0) return;
  const numeric = typeof code === 'number' ? code : -1;
  const msg = typeof rec?.msg === 'string' && rec.msg ? rec.msg : 'cardkit.card.update failed';
  throw new CardKitApiError(numeric, msg);
}

function cardUpdate(channel: LarkChannel): ((params: unknown) => Promise<unknown>) | undefined {
  const raw = (channel as { rawClient?: unknown }).rawClient;
  const card = asRecord(asRecord(asRecord(asRecord(raw)?.cardkit)?.v1)?.card);
  const update = card?.update;
  if (typeof update !== 'function') return undefined;
  return (update as (params: unknown) => Promise<unknown>).bind(card);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
