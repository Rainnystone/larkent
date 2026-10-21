import { createHash, randomBytes } from 'node:crypto';

/** Submission lifetime; receipts remain queryable after this deadline. */
export const AUTOMATION_OPERATION_TTL_MS = 24 * 60 * 60_000;
export function automationOperationScope(profile: string, chatId: string): string {
  return createHash('sha256').update(JSON.stringify([profile, chatId])).digest('hex').slice(0, 24);
}
export function newAutomationOperationId(scope: string, now = Date.now()): string {
  return `op1.${scope}.${now}.${randomBytes(16).toString('hex')}`;
}
export function readAutomationOperationId(value: unknown): { scope: string; issuedAt: number } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^op1\.([a-f0-9]{24})\.(\d{13})\.([a-f0-9]{32})$/.exec(value);
  return match ? { scope: match[1]!, issuedAt: Number(match[2]) } : undefined;
}
