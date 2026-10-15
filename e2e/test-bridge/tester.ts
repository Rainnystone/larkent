import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestBridgeConfig } from './config';

export interface SentMessage {
  messageId?: string;
  chatId: string;
  text: string;
}

export interface ReadMessage {
  messageId?: string;
  text: string;
  createTime?: string;
}

const OPEN_HOST: Record<TestBridgeConfig['tenant'], string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

export async function sendTesterMessage(
  config: TestBridgeConfig,
  text: string,
): Promise<SentMessage> {
  const token = await readTesterToken(config);
  const mention = config.botOpenId
    ? `<at user_id="${config.botOpenId}"></at> ${text}`
    : text;
  const body = await feishuJson(config.tenant, token, '/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    payload: {
      receive_id: config.chatId,
      msg_type: 'text',
      content: JSON.stringify({ text: mention }),
    },
  });
  const data = isRecord(body.data) ? body.data : {};
  return {
    chatId: config.chatId,
    text: mention,
    ...(typeof data.message_id === 'string' ? { messageId: data.message_id } : {}),
  };
}

export async function readTesterMessages(
  config: TestBridgeConfig,
  opts: { pageSize?: number } = {},
): Promise<ReadMessage[]> {
  const token = await readTesterToken(config);
  const pageSize = opts.pageSize ?? 20;
  const path = `/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(config.chatId)}&page_size=${pageSize}&sort_type=ByCreateTimeDesc`;
  const body = await feishuJson(config.tenant, token, path, { method: 'GET' });
  const data = isRecord(body.data) ? body.data : {};
  const items = Array.isArray(data.items) ? data.items : [];
  return items.flatMap((item) => {
    if (!isRecord(item)) return [];
    const messageId = typeof item.message_id === 'string' ? item.message_id : undefined;
    const createTime = typeof item.create_time === 'string' ? item.create_time : undefined;
    const text = extractText(item);
    return [{ ...(messageId ? { messageId } : {}), text, ...(createTime ? { createTime } : {}) }];
  });
}

async function readTesterToken(config: TestBridgeConfig): Promise<string> {
  const tokenFile = config.testerTokenFile ?? join(config.testerConfigDir, 'user-token');
  try {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (!token) throw new Error('tester token file is empty');
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `tester token not found at ${tokenFile}; put a user access token in the gitignored tester config dir`,
      );
    }
    throw err;
  }
}

async function feishuJson(
  tenant: TestBridgeConfig['tenant'],
  token: string,
  path: string,
  opts: { method: 'GET' | 'POST'; payload?: unknown },
): Promise<{ code?: unknown; msg?: unknown; data?: unknown }> {
  const resp = await fetch(`${OPEN_HOST[tenant]}${path}`, {
    method: opts.method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    ...(opts.payload !== undefined ? { body: JSON.stringify(opts.payload) } : {}),
  });
  const json = (await resp.json()) as { code?: unknown; msg?: unknown; data?: unknown };
  if (!resp.ok || json.code !== 0) {
    throw new Error(`tester API failed: ${String(json.msg ?? resp.status)}`);
  }
  return json;
}

function extractText(item: Record<string, unknown>): string {
  const body = item.body;
  if (!isRecord(body) || typeof body.content !== 'string') return '';
  try {
    const parsed = JSON.parse(body.content) as unknown;
    if (isRecord(parsed) && typeof parsed.text === 'string') return parsed.text;
  } catch {
    return body.content;
  }
  return body.content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
