import { createHash } from 'node:crypto';

/** Spec D3 formula, kept in tests so expected hashes are independent of production code. */
export function specTaskKey(profile: string, chatId: string, sourceMessageId: string): string {
  return createHash('sha256')
    .update(`${profile}\n${chatId}\n${sourceMessageId}`)
    .digest('hex')
    .slice(0, 32);
}

export function last6(value: string): string {
  return value.length <= 6 ? value : `...${value.slice(-6)}`;
}
