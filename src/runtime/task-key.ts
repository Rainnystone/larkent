import { createHash } from 'node:crypto';

/** Stable task identity for `run`/`started`: first 32 hex of sha256(profile + newline + chatId + newline + sourceMessageId). */
export function computeRunTaskKey(profile: string, chatId: string, sourceMessageId: string): string {
  return createHash('sha256')
    .update(`${profile}\n${chatId}\n${sourceMessageId}`)
    .digest('hex')
    .slice(0, 32);
}
