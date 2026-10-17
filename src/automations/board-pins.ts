import type { LarkChannel } from '@larksuite/channel';
import { withOutboundTimeout } from '../bot/self-message';

interface PinApi {
  create(params: { data: { message_id: string } }): Promise<unknown>;
  list(params: {
    params: { chat_id: string; page_size?: number; page_token?: string };
  }): Promise<unknown>;
  delete(params: { path: { message_id: string } }): Promise<unknown>;
}

export async function listPinnedMessageIds(channel: LarkChannel, chatId: string): Promise<string[]> {
  const pin = pinApi(channel);
  if (!pin) return [];
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await withOutboundTimeout(
      'pin.list',
      pin.list({
        params: {
          chat_id: chatId,
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }),
    );
    const data = asRecord(asRecord(res)?.data);
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      const rec = asRecord(item);
      if (typeof rec?.message_id === 'string' && rec.message_id) ids.push(rec.message_id);
    }
    pageToken = typeof data?.page_token === 'string' && data.has_more === true ? data.page_token : undefined;
  } while (pageToken);
  return ids;
}

export async function pinMessage(channel: LarkChannel, messageId: string): Promise<void> {
  const pin = pinApi(channel);
  if (!pin) return;
  await withOutboundTimeout('pin.create', pin.create({ data: { message_id: messageId } }));
}

export async function unpinMessage(channel: LarkChannel, messageId: string): Promise<void> {
  const pin = pinApi(channel);
  if (!pin) return;
  await withOutboundTimeout('pin.delete', pin.delete({ path: { message_id: messageId } }));
}

function pinApi(channel: LarkChannel): PinApi | undefined {
  const raw = (channel as { rawClient?: unknown }).rawClient;
  const im = asRecord(raw)?.im;
  const v1 = asRecord(im)?.v1;
  const pin = asRecord(v1)?.pin ?? asRecord(im)?.pin;
  if (!isObject(pin)) return undefined;
  if (typeof pin.create !== 'function' || typeof pin.list !== 'function' || typeof pin.delete !== 'function') {
    return undefined;
  }
  return pin as unknown as PinApi;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
