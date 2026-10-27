import { readFile, writeFile } from 'node:fs/promises';
import { createRecordingLarkChannel } from './recording-lark-channel';

type RemoteMessage = {
  id: string;
  uuid?: string;
  content: unknown;
  recalled?: boolean;
};
export async function remoteMessages(path: string): Promise<RemoteMessage[]> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RemoteMessage[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** External Feishu adapter with state that survives killing the bridge fixture. */
export function crashRecordingChannel(path: string) {
  const channel = createRecordingLarkChannel();
  const send = channel.send.bind(channel);
  channel.send = async (chatId, content, options) => {
    const messages = await remoteMessages(path);
    const uuid = (options as { uuid?: string } | undefined)?.uuid;
    const existing = uuid
      ? messages.find((message) => message.uuid === uuid)
      : undefined;
    if (existing) return { messageId: existing.id };
    await send(chatId, content, options);
    const id = `receipt-${messages.length + 1}`;
    messages.push({ id, ...(uuid ? { uuid } : {}), content });
    await writeFile(path, JSON.stringify(messages));
    return { messageId: id };
  };
  const recall = channel.recallMessage.bind(channel);
  channel.recallMessage = async (id) => {
    await recall(id);
    const messages = await remoteMessages(path);
    const message = messages.find((message) => message.id === id);
    if (message) message.recalled = true;
    await writeFile(path, JSON.stringify(messages));
  };
  return channel;
}
