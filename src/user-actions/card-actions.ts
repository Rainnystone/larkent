import type { BoardPayload } from '../automations/board-auth';
import { handleDraftAction } from '../automations/draft-confirmation';
import { AUTO_BOARD_UPDATED_HINT, AUTO_INVALID_HINT, AUTO_UNKNOWN_ID } from '../automations/command';
import { mutateAutomationTask, taskMutationLabels } from '../automations/task-mutation';
import { resolvedNoticeCard, resolveInterruptionNotice, type NoticePayload } from '../bot/interruption-notice';
import { withFreshClickId } from '../card/templates';
import { renderCommandCard } from '../commands/handlers';
import { log } from '../core/logger';
import type { UserActionContext } from './context';
import type { ActionPayload, ActionResponse } from './definition';
import { enqueueActionMessage } from './message';
import { isAutoCardAction } from '../automations/action-auth';

export const BRIDGE_CALLBACK_MARKER = '__bridge_cb';
export const LEGACY_CALLBACK_MARKER = '__claude_cb';

export function verifyBridgeAction(ctx: UserActionContext, payload: ActionPayload): true | undefined {
  const action = typeof payload.cmd === 'string' && payload.cmd ? payload.cmd : 'agent_callback';
  const active = ctx.activeRuns.get(ctx.scope);
  const token = typeof payload.bridge_token === 'string' ? payload.bridge_token : '';
  if (!ctx.callbackAuth || !token || !active) {
    log.warn('callback', 'denied', { scope: ctx.scope, action, reason: 'missing-token-or-run' });
    return;
  }
  const result = ctx.callbackAuth.verify(token, {
    runId: active.run.runId, scope: ctx.scope, chatId: ctx.msg.chatId,
    operatorOpenId: ctx.msg.senderId, action,
    policyFingerprint: ctx.callbackPolicyFingerprintForScope?.(ctx.scope) ?? ctx.callbackPolicyFingerprint ?? '',
  });
  if (!result.ok) {
    log.warn('callback', 'denied', { scope: ctx.scope, action, reason: result.reason });
    return;
  }
  return true;
}

export async function forwardBridgeAction(ctx: UserActionContext, payload: ActionPayload): Promise<void> {
  const { [BRIDGE_CALLBACK_MARKER]: _marker, bridge_token: _token, ...agentPayload } = payload;
  const merged = ctx.formValue ? { ...agentPayload, form_value: ctx.formValue } : agentPayload;
  log.info('cardAction', 'forward-agent', { scope: ctx.scope, payload: JSON.stringify(merged).slice(0, 200) });
  enqueueActionMessage(ctx.pending, ctx.scope, ctx.msg, {
    content: `[card-click] ${JSON.stringify(merged)}`, rawContentType: 'card_action',
  });
}

export function verifyNoticeAction(ctx: UserActionContext, payload: ActionPayload): NoticePayload | undefined {
  const action = payload.cmd;
  if (action !== 'notice.continue' && action !== 'notice.dismiss') return;
  const token = typeof payload.notice_token === 'string' ? payload.notice_token : '';
  const result = ctx.noticeAuth?.verify(token, { scope: ctx.scope, chatId: ctx.msg.chatId, action });
  return result?.ok ? result.payload : undefined;
}

const CLICK_PATCH_FALLBACK_MS = 1_500;
// Real Feishu click spinners ran 5-8 s; re-assert once after that window so a late callback completion cannot leave the old card.
const CLICK_PATCH_REASSERT_MS = 10_000;

export async function handleNoticeAction(ctx: UserActionContext, _payload: ActionPayload, claims: NoticePayload): Promise<ActionResponse> {
  const entry = ctx.journal?.get(claims.turnId);
  if (!entry || entry.noticeInvalidated || entry.status === 'voided'
    || (entry.policyFingerprint && entry.policyFingerprint !== claims.policyFingerprint)) {
    return sendNoticeInvalid(ctx);
  }
  const identity = ctx.resolveSessionCatalogIdentity ? await ctx.resolveSessionCatalogIdentity() : ctx.sessionCatalogIdentity;
  if (identity && identity.policyFingerprint !== claims.policyFingerprint) return sendNoticeInvalid(ctx);
  if (claims.action === 'notice.continue' && ctx.continuations && !ctx.continuations.click(entry.turnId)) {
    return sendNoticeInvalid(ctx);
  }
  if (claims.action === 'notice.dismiss') {
    if (ctx.continuations) ctx.continuations.dismiss(entry.turnId);
    else ctx.journal?.invalidateNotice(entry.turnId);
    log.info('notice', 'dismissed', { turnId: entry.turnId, scope: ctx.scope });
    const journal = ctx.journal;
    if (!journal || !entry.notice?.includeButtons) return;
    const messageId = entry.notice.messageId;
    const settle = () => void resolveInterruptionNotice({
      journal, turnId: entry.turnId, resolution: 'dismissed',
      updateCard: (id, card) => ctx.channel.updateCard(id, card),
    });
    setTimeout(settle, CLICK_PATCH_FALLBACK_MS).unref();
    setTimeout(() => {
      if (journal.get(entry.turnId)?.notice?.messageId === messageId) settle();
    }, CLICK_PATCH_REASSERT_MS).unref();
    return { card: { type: 'raw', data: resolvedNoticeCard('dismissed') } };
  }
  enqueueActionMessage(ctx.pending, ctx.scope, ctx.msg, {
    messageId: ctx.msg.messageId || entry.messageIds.at(-1) || `notice-continue-${entry.turnId}`,
    chatId: entry.chatId, senderName: '', mentionedBot: true,
    content: entry.resumeHandle ? '继续' : (entry.userInput ?? '继续'), rawContentType: 'text',
    resources: (entry.resources ?? []).map(resource => ({ ...resource })),
  });
}

const latestCommandClicks = new Map<string, symbol>();

/**
 * Re-renders the clicked command card from current state with fresh click
 * ids, so its buttons accept a repeat click. Feishu applies the callback's
 * card; the same card is patched again after the click spinner unless a later
 * click on that message has arrived since.
 */
export async function rerenderCommandCard(ctx: UserActionContext, payload: ActionPayload): Promise<ActionResponse> {
  if (payload.card === undefined) return;
  const messageId = ctx.msg.messageId;
  const click = Symbol(messageId);
  latestCommandClicks.set(messageId, click);
  let rendered: object | undefined;
  try {
    const invocation = ctx.resolveSessionCatalogIdentity
      ? { ...ctx, sessionCatalogIdentity: await ctx.resolveSessionCatalogIdentity() } : ctx;
    rendered = await renderCommandCard(invocation, payload);
  } catch (error) {
    log.warn('cardAction', 'rerender-failed', { err: error instanceof Error ? error.message : String(error) });
  }
  const isLatest = () => latestCommandClicks.get(messageId) === click;
  if (!rendered) {
    if (isLatest()) latestCommandClicks.delete(messageId);
    return;
  }
  const card = withFreshClickId(rendered);
  const reassert = (last: boolean) => {
    if (!isLatest()) return;
    if (last) latestCommandClicks.delete(messageId);
    ctx.channel.updateCard(messageId, card).catch((error: unknown) => {
      log.warn('cardAction', 'rerender-patch-failed', { err: error instanceof Error ? error.message : String(error) });
    });
  };
  setTimeout(() => reassert(false), CLICK_PATCH_FALLBACK_MS).unref();
  setTimeout(() => reassert(true), CLICK_PATCH_REASSERT_MS).unref();
  return { card: { type: 'raw', data: card } };
}

export async function sendNoticeInvalid(ctx: UserActionContext): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown: '此继续已失效。' }, { replyTo: ctx.msg.messageId });
  } catch (error) {
    log.warn('notice', 'invalid-hint-failed', { err: error instanceof Error ? error.message : String(error) });
  }
}

function canUseAutomations(ctx: UserActionContext): boolean {
  return ctx.controls.profileConfig.automations.enabled
    && ctx.msg.senderId !== ctx.channel.botIdentity?.openId;
}

export function verifyDraftAction(ctx: UserActionContext, payload: ActionPayload): true | undefined {
  const action = payload.cmd;
  if (!canUseAutomations(ctx) || typeof action !== 'string' || !isAutoCardAction(action)) return;
  const token = typeof payload.auto_token === 'string' ? payload.auto_token : '';
  // Deferred nonce: D07 retains registration checks and the claim/consume lifecycle.
  return ctx.autoAuth?.verify(token, { chatId: ctx.msg.chatId, action }).ok ? true : undefined;
}

export async function handleAutomationAction(ctx: UserActionContext, payload: ActionPayload): Promise<ActionResponse> {
  const action = payload.cmd;
  if (typeof action !== 'string' || !isAutoCardAction(action)) return automationInvalid();
  const formEnd = ctx.formValue?.end_at;
  const payloadEnd = payload.end_at;
  const customText = typeof formEnd === 'string' && formEnd.trim() ? formEnd.trim()
    : typeof payloadEnd === 'string' && payloadEnd.trim() ? payloadEnd.trim() : undefined;
  const result = await handleDraftAction(ctx, {
    action, token: typeof payload.auto_token === 'string' ? payload.auto_token : '',
    chatId: ctx.msg.chatId, messageId: ctx.msg.messageId, customText,
  });
  return actionToast(result.ok ? 'success' : 'error', result.message);
}

export function verifyBoardAction(ctx: UserActionContext, payload: ActionPayload): BoardPayload | undefined {
  const action = payload.cmd;
  if (!canUseAutomations(ctx) || !ctx.automations || !ctx.automationsScheduler
    || (action !== 'auto.pause' && action !== 'auto.resume' && action !== 'auto.delete')) return;
  const token = typeof payload.auto_token === 'string' ? payload.auto_token : '';
  const result = ctx.boardAuth?.verify(token, { chatId: ctx.msg.chatId, action });
  return result?.ok ? result.payload : undefined;
}

export async function handleBoardAction(ctx: UserActionContext, _payload: ActionPayload, claims: BoardPayload): Promise<ActionResponse> {
  const registered = ctx.automations?.findBoardByMessageId(ctx.msg.messageId);
  if (!registered || registered.messageId !== ctx.msg.messageId) return actionToast('error', AUTO_BOARD_UPDATED_HINT);
  if (claims.chatId !== registered.chatId || !ctx.automations || !ctx.automationsScheduler) return automationInvalid();
  const operation = claims.action === 'auto.pause' ? 'pause' : claims.action === 'auto.resume' ? 'resume' : 'delete';
  const result = await mutateAutomationTask({ store: ctx.automations, scheduler: ctx.automationsScheduler, chatId: registered.chatId }, {
    actor: 'human', operation, id: claims.itemId,
  });
  if (!result.ok) return actionToast('error', AUTO_UNKNOWN_ID);
  log.info('auto', { pause: 'paused', resume: 'resumed', delete: 'deleted' }[operation], { id: claims.itemId });
  return actionToast('success', `已${taskMutationLabels[operation]} #${claims.itemId}`);
}

export async function automationInvalid(): Promise<ActionResponse> {
  return actionToast('error', AUTO_INVALID_HINT);
}

function actionToast(type: 'success' | 'error', content: string): ActionResponse {
  return { toast: { type, content } };
}
