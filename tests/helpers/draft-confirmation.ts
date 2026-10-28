import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AutoActionAuth, AUTO_CARD_TTL_MS } from '../../src/automations/action-auth';
import {
  draftConfirmationDelivery,
  flushDraftConfirmations,
  handleDraftAction,
  type DraftConfirmationContext,
} from '../../src/automations/draft-confirmation';
import { formatZonedDateTime } from '../../src/automations/confirm-card';
import type { AutomationDraft, AutomationsStore } from '../../src/automations/store';
import { CallbackNonceStore } from '../../src/card/callback-store';
import { createRecordingLarkChannel } from './recording-lark-channel';

/** Exercise existing mutation characterizations through the lifecycle's real seam. */
export async function confirmAutomationDraft(ctx: Partial<DraftConfirmationContext> & { automations?: AutomationsStore }, draft: AutomationDraft) {
  const result = await act(ctx, draft, 'auto.confirm');
  return { ok: result.ok, status: result.message, toast: result.message };
}

export async function completeDraftEnd(ctx: Partial<DraftConfirmationContext> & { automations: AutomationsStore }, draft: AutomationDraft, endAt: number, _replyTo: string) {
  if (draft.op === 'delete') throw new Error('Expected an end-date draft');
  const result = await act(ctx, draft, 'auto.end.custom', formatZonedDateTime(draft.timezone, endAt));
  return result.ok ? { ok: true as const } : { ok: false as const, message: result.message };
}

async function act(ctx: Partial<DraftConfirmationContext> & { automations?: AutomationsStore }, draft: AutomationDraft, action: 'auto.confirm' | 'auto.end.custom', customText?: string) {
  if (!ctx.automations) throw new Error('Expected an automations store');
  const now = ctx.now ?? (() => draft.createdAt);
  const nonceStore = new CallbackNonceStore(join(dirname(ctx.automations.getFilePath()), `test-nonces-${randomUUID()}.json`));
  const autoAuth = new AutoActionAuth({ secret: 'synthetic-confirmation', nonceStore, now });
  const context = { ...ctx, channel: ctx.channel ?? createRecordingLarkChannel() as never, autoAuth, now };
  await flushDraftConfirmations(context, draft.draftId);
  const current = ctx.automations.getDraft(draft.draftId);
  const messageId = draftConfirmationDelivery(current).messageId ?? '';
  const token = autoAuth.sign({ draftId: draft.draftId, chatId: draft.chatId, action, ttlMs: AUTO_CARD_TTL_MS });
  const result = await handleDraftAction(context, { action, token, chatId: draft.chatId, messageId, customText });
  await nonceStore.flush();
  await new Promise(resolve => setImmediate(resolve));
  return result;
}
