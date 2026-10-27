import { mutateAutomationTask, readAutomationTask } from './task-mutation';
import { cardDraft, type DraftCardPatch } from './draft-confirmation/state';
import { reconcileDraftCard, sendAutomationDraftCard } from './draft-confirmation/delivery';
import { log } from '../core/logger';
import { classify, isNotInChat } from '../bot/feishu-error';
import { readCardApiError } from '../card/card-api-error';
import { abandonIfNotInChat } from './chat-lifecycle';
import type { CommandContext } from '../commands';
import { AUTO_CARD_TTL_MS, type AutoActionAuth, type AutoCardAction, isAutoEndAction } from './action-auth';
import { automationConfirmCard, automationDeleteCard, automationReplaceCard } from './confirm-card';
import { automationEndCard, type EndCardTokens } from './end-card';
import { nextFireAfter, parseSchedule, readSchedule, type Schedule } from './schedule';
import { zonedParts } from './zoned-time';
import { draftConfirmedStatus, draftDeletedStatus, draftReplacedStatus, draftSameNameExistsStatus, draftTargetGoneStatus, draftTargetChangedStatus, DRAFT_SETTLED_SUPERSEDED, DRAFT_SETTLED_CANCELLED, DRAFT_SETTLED_END_CHOSEN, scheduleDraftCardSettle } from './draft-confirmation/settlement';
import { AUTOMATIONS_DRAFT_TTL_MS, type AutomationDraft, type AutomationItem, type AutomationsStore, type DeleteAutomationDraft, type ReplaceAutomationDraft, type SaveAutomationDraftInput, type RegisterAutomationOperationInput } from './store';
import { AUTO_INVALID_HINT, AUTO_INVALID_END, AUTO_END_BUSY, AUTO_END_NOT_AFTER_START, AUTO_NO_REMAINING_FIRES, AUTO_AGENT_NEEDS_CWD, assessAutomationSchedule, hasRemainingFire, noteAutomationRejected, rejectMessage, completePendingSchedule, resolveEndAt, scheduleStartAt, scheduleEndAt, type AutomationScheduleVerdict } from './command-schedule';
export type DraftConfirmationContext = {
  botAppId?: string;
  channel: CommandContext['channel'];
  automations?: AutomationsStore;
  autoAuth?: AutoActionAuth;
  automationsScheduler?: CommandContext['automationsScheduler'];
  now?: () => number;
  isLinkDown?: () => boolean;
  onAutomationConfirmed?: CommandContext['onAutomationConfirmed'];
};

/** In-flight card claim per draft. Bind happens after send, so a second flush must wait. */
const draftCardClaims = new WeakMap<AutomationsStore, Map<string, Promise<void>>>();

async function flushPendingDraftCards(ctx: DraftConfirmationContext): Promise<void> {
  if (!ctx.automations || !ctx.autoAuth || ctx.isLinkDown?.()) return;
  const now = (ctx.now ?? Date.now)();
  for (const draft of ctx.automations.listDrafts()) {
    if (cardDraft(draft).cardMessageId) continue;
    try {
      await flushDraftCardOnce(ctx, draft.draftId, now);
    } catch (error) {
      log.fail('auto', error, { event: 'draft.flush', draftId: draft.draftId });
    }
  }
}

async function flushDraftCardOnce(ctx: DraftConfirmationContext, draftId: string, now: number): Promise<void> {
  const automations = ctx.automations;
  if (!automations || !ctx.autoAuth || ctx.isLinkDown?.()) return;
  let claims = draftCardClaims.get(automations);
  if (!claims) { claims = new Map(); draftCardClaims.set(automations, claims); }
  for (;;) {
    const inflight = claims.get(draftId);
    if (inflight) {
      await inflight;
      continue;
    }
    const draft = automations.getDraft(draftId);
    if (!draft || cardDraft(draft).cardMessageId) return;
    if (cardDraft(draft).delivery?.state === 'sending') { await reconcileDraftCard(ctx.channel, automations, draft, ctx.botAppId); return; }
    if (draft.operationId && cardDraft(draft).delivery?.state === 'rejected') return;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    claims.set(draftId, gate);
    try {
      await deliverUnboundDraftCard(ctx, draft, now);
    } finally {
      if (claims.get(draftId) === gate) claims.delete(draftId);
      release();
    }
    return;
  }
}

async function deliverUnboundDraftCard(ctx: DraftConfirmationContext, draft: AutomationDraft, now: number): Promise<void> {
  if (!ctx.automations || !ctx.autoAuth) return;
  const replyTo = draft.cardReply?.replyTo ?? '';
  const cardCtx = { ...ctx, chatMode: draft.cardReply?.replyInThread ? 'topic' as const : 'group' as const,
    msg: { chatId: draft.chatId, threadId: draft.cardReply?.threadId } };
  let card: object;
  const sign = (action: AutoCardAction) => ctx.autoAuth!.sign({ draftId: draft.draftId, chatId: draft.chatId, action, ttlMs: AUTO_CARD_TTL_MS });
  if (draft.op !== 'delete' && draft.pendingRecurring) {
    card = automationEndCard(signEndTokens(ctx.autoAuth, draft));
  } else {
    const tokens = { confirmToken: sign('auto.confirm'), rejectToken: sign('auto.reject') };
    if (draft.op === 'delete') card = automationDeleteCard({ target: draft.target, ...tokens });
    else {
      const schedule = readSchedule(draft.schedule);
      if (!schedule) return;
      if (!hasRemainingFire(schedule, now)) {
        try {
          await ctx.channel.send(draft.chatId, { markdown: AUTO_NO_REMAINING_FIRES }, {
            ...(replyTo ? { replyTo } : {}), ...(draft.cardReply?.replyInThread ? { replyInThread: true } : {}),
          });
        } catch (error) {
          if (await abandonIfNotInChat(error, draft.chatId, chatId => ctx.automationsScheduler?.removeFromChat(chatId))) return;
          if (classify(error) === 'link') return;
          log.warn('auto', 'reply-failed', { err: error instanceof Error ? error.message : String(error) });
        }
        await ctx.automations.takeDraft(draft.draftId);
        noteAutomationRejected('no-remaining-fires', 'command');
        return;
      }
      const body = { taskType: draft.taskType, name: draft.name, taskText: draft.taskText,
        timezone: draft.timezone, schedule, now, ...tokens, ...(draft.cwd ? { cwd: draft.cwd } : {}) };
      card = draft.op === 'replace' ? automationReplaceCard({ ...body, target: draft.target }) : automationConfirmCard(body);
    }
  }
  try {
    await sendAutomationDraftCard(ctx.channel, ctx.automations, draft, card, draft.cardReply ?? {});
  } catch (error) {
    if (draft.operationId) {
      await abandonIfNotInChat(error, draft.chatId, chatId => ctx.automationsScheduler?.removeFromChat(chatId));
      throw error;
    }
    await settleDraftCardFailure(cardCtx, draft, error, replyTo);
  }
}

async function completeDraftEnd(
  ctx: {
    automations: AutomationsStore;
    autoAuth: AutoActionAuth;
    automationsScheduler?: CommandContext['automationsScheduler'];
    channel: CommandContext['channel'];
    now?: () => number;
    chatMode?: CommandContext['chatMode'];
  },
  draft: Exclude<AutomationDraft, DeleteAutomationDraft>,
  endAt: number,
  replyTo: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const pending = draft.pendingRecurring;
  if (!pending) return { ok: false, message: AUTO_INVALID_HINT };
  if (endAt <= draft.startAt) return { ok: false, message: AUTO_END_NOT_AFTER_START };
  const now = (ctx.now ?? Date.now)();
  const parsed = completePendingSchedule(pending, endAt, {
    taskType: draft.taskType,
    now,
    startAt: draft.startAt,
  });
  if (!parsed.ok) return { ok: false, message: rejectMessage(parsed.reason) };
  if (!hasRemainingFire(parsed.schedule, now)) {
    return { ok: false, message: rejectMessage('no-remaining-fires') };
  }
  // A second tap on this end card is still queued behind this await. Leave
  // the binding in place until it can lose the nonce check, then drop the
  // end card before the confirm send so a link failure can be retried.
  await Promise.resolve();
  const nextFireAt = nextFireAfter(parsed.schedule, now);
  const updated = await ctx.automations.updateDraft(draft.draftId, {
    schedule: parsed.schedule,
    endAt,
    nextFireAt,
    pendingRecurring: null,
    ...({ cardMessageId: null } as DraftCardPatch),
    cardReply: { ...(draft.cardReply ?? {}), replyTo },
  });
  if (!updated || updated.op === 'delete') return { ok: false, message: AUTO_INVALID_HINT };
  await flushDraftConfirmations(ctx, updated.draftId);
  return { ok: true };
}

interface AutomationConfirmOutcome {
  ok: boolean;
  status: string;
  toast: string;
}

async function confirmAutomationDraft(
  ctx: Pick<CommandContext, 'automations' | 'automationsScheduler' | 'onAutomationConfirmed'> & {
    now?: () => number;
  },
  draft: AutomationDraft,
): Promise<AutomationConfirmOutcome> {
  if (draft.op !== 'create' && ctx.automations) {
    const target = readAutomationTask(ctx.automations, { id: draft.targetId, chatId: draft.chatId, revision: draft.target.revision, consistency: 'live' });
    if (!target.ok) {
      const code = target.code;
      const status = code === 'target-not-found' ? draftTargetGoneStatus(draft.targetId) : draftTargetChangedStatus(draft.targetId);
      if (draft.operationId) await ctx.automations.rejectOperation(draft.operationId, code, status);
      return { ok: false, status, toast: status };
    }
  }
  switch (draft.op) {
    case 'create':
      return confirmCreateDraft(ctx, draft);
    case 'delete':
      return confirmDeleteDraft(ctx, draft);
    case 'replace':
      return confirmReplaceDraft(ctx, draft);
    default: {
      const _exhaustive: never = draft;
      return _exhaustive;
    }
  }
}

async function confirmCreateDraft(
  ctx: Pick<CommandContext, 'automations' | 'onAutomationConfirmed'>,
  draft: Exclude<AutomationDraft, DeleteAutomationDraft | ReplaceAutomationDraft>,
): Promise<AutomationConfirmOutcome> {
  if (!ctx.automations || draft.pendingRecurring) return confirmInvalid();
  const conflict = findSameNameCreateConflict(ctx.automations, draft);
  if (conflict) {
    const status = draftSameNameExistsStatus(conflict.id);
    if (draft.operationId) await ctx.automations.rejectOperation(draft.operationId, 'same-name-confirmed', status);
    return { ok: false, status, toast: status };
  }
  const item = await ctx.automations.create({
    confirmedDraftId: draft.draftId,
    ...(draft.operationId ? { operationId: draft.operationId } : {}),
    taskType: draft.taskType,
    schedule: draft.schedule,
    timezone: draft.timezone,
    startAt: draft.startAt,
    ...(draft.endAt !== undefined ? { endAt: draft.endAt } : {}),
    nextFireAt: draft.nextFireAt,
    chatId: draft.chatId,
    createdBy: draft.createdBy,
    name: draft.name,
    taskText: draft.taskText,
    ...(draft.cwd ? { cwd: draft.cwd } : {}),
  });
  log.info('auto', 'confirmed', { id: item.id, taskType: item.taskType, chatId: item.chatId });
  scheduleAutomationConfirmed(ctx.onAutomationConfirmed, item);
  const status = draftConfirmedStatus(item.id);
  return { ok: true, status, toast: status };
}

async function confirmDeleteDraft(
  ctx: Pick<CommandContext, 'automations' | 'automationsScheduler'>,
  draft: DeleteAutomationDraft,
): Promise<AutomationConfirmOutcome> {
  if (!ctx.automations || !ctx.automationsScheduler) return confirmInvalid();
  const result = await mutateAutomationTask({ store: ctx.automations, scheduler: ctx.automationsScheduler, chatId: draft.chatId }, {
    actor: 'human', operation: 'delete', id: draft.targetId, revision: draft.target.revision,
    confirmation: { draftId: draft.draftId, operationId: draft.operationId },
  });
  if (!result.ok) {
    const code = result.code;
    const status = code === 'target-state-conflict' ? draftTargetChangedStatus(draft.targetId) : draftTargetGoneStatus(draft.targetId);
    if (draft.operationId) await ctx.automations.rejectOperation(draft.operationId, code, status);
    return { ok: false, status, toast: status };
  }
  log.info('auto', 'deleted', { id: draft.targetId, source: 'confirmation' });
  const status = draftDeletedStatus(draft.targetId);
  return { ok: true, status, toast: status };
}

async function confirmReplaceDraft(
  ctx: Pick<CommandContext, 'automations' | 'automationsScheduler' | 'onAutomationConfirmed'> & {
    now?: () => number;
  },
  draft: ReplaceAutomationDraft,
): Promise<AutomationConfirmOutcome> {
  if (!ctx.automations || !ctx.automationsScheduler || draft.pendingRecurring) return confirmInvalid();
  const now = (ctx.now ?? Date.now)();
  const blocked = replaceConfirmBlock(draft, now);
  if (blocked.outcome !== 'confirm') {
    if (blocked.outcome === 'reject') noteAutomationRejected(blocked.reason, 'confirmation');
    const message = blocked.outcome === 'reject'
      ? rejectMessage(blocked.reason, blocked)
      : blocked.outcome === 'refuse'
        ? blocked.message
        : AUTO_INVALID_HINT;
    if (draft.operationId) await ctx.automations.rejectOperation(draft.operationId, blocked.outcome === 'reject' ? blocked.reason : 'confirmation-invalid', message);
    return { ok: false, status: message, toast: message };
  }
  let created: AutomationItem | undefined;
  try {
    const nextFireAt = nextFireAfter(blocked.schedule, now);
    const startAt = scheduleStartAt(blocked.schedule, now);
    const endAt = scheduleEndAt(blocked.schedule);
    const result = await mutateAutomationTask({ store: ctx.automations, scheduler: ctx.automationsScheduler, chatId: draft.chatId }, {
      actor: 'human', operation: 'replace', id: draft.targetId, revision: draft.target.revision,
      confirmation: { draftId: draft.draftId, operationId: draft.operationId }, replacement: {
      taskType: draft.taskType,
      schedule: blocked.schedule,
      timezone: draft.timezone,
      startAt,
      ...(endAt !== undefined ? { endAt } : {}),
      nextFireAt,
      chatId: draft.chatId,
      createdBy: draft.createdBy,
      name: draft.name,
      taskText: draft.taskText,
      ...(draft.cwd ? { cwd: draft.cwd } : {}),
      },
    });
    if (!result.ok) {
      const status = result.code === 'target-state-conflict' ? draftTargetChangedStatus(draft.targetId) : draftTargetGoneStatus(draft.targetId);
      if (draft.operationId) await ctx.automations.rejectOperation(draft.operationId, result.code, status);
      return { ok: false, status, toast: status };
    }
    created = result.item;
  } catch (error) {
    if (draft.operationId) throw error;
    log.fail('auto', error, { event: 'replace', oldId: draft.targetId });
    const status = `没有替换 #${draft.targetId}：新任务未创建`;
    return { ok: false, status, toast: status };
  }
  if (!created) {
    if (draft.operationId) await ctx.automations.takeDraft(draft.draftId);
    const status = draftTargetGoneStatus(draft.targetId);
    return { ok: false, status, toast: status };
  }
  log.info('auto', 'replaced', { oldId: draft.targetId, newId: created.id });
  scheduleAutomationConfirmed(ctx.onAutomationConfirmed, created);
  const status = draftReplacedStatus(draft.targetId, created.id);
  return { ok: true, status, toast: status };
}

function confirmInvalid(): AutomationConfirmOutcome {
  return { ok: false, status: DRAFT_SETTLED_CANCELLED, toast: AUTO_INVALID_HINT };
}

function scheduleAutomationConfirmed(
  onConfirmed: ((item: AutomationItem) => void | Promise<void>) | undefined,
  item: AutomationItem,
): void {
  if (!onConfirmed) return;
  void (async () => {
    try {
      await onConfirmed(item);
    } catch (error) {
      log.fail('auto', error, { event: 'confirmed-follow-up', id: item.id });
    }
  })();
}

function findSameNameCreateConflict(
  store: AutomationsStore,
  draft: Exclude<AutomationDraft, DeleteAutomationDraft | ReplaceAutomationDraft>,
): AutomationItem | undefined {
  const name = draft.name.trim();
  return store.list().find(item => item.chatId === draft.chatId && item.createdBy === draft.createdBy
    && item.name.trim() === name && (store.appliedOperationAppliedAt(item.id) ?? 0) >= draft.createdAt);
}

function replaceConfirmBlock(draft: ReplaceAutomationDraft, now: number): AutomationScheduleVerdict {
  if (draft.taskType === 'agent' && !(draft.cwd && draft.cwd.trim())) {
    return { outcome: 'refuse', message: AUTO_AGENT_NEEDS_CWD };
  }
  if (draft.scheduleText) {
    const textVerdict = assessAutomationSchedule({
      taskType: draft.taskType,
      scheduleText: draft.scheduleText,
      now,
      timezone: draft.timezone,
      hasCwd: true,
    });
    if (textVerdict.outcome === 'reject' && textVerdict.reason === 'past-time') return textVerdict;
    if (textVerdict.outcome === 'refuse') return textVerdict;
  }
  const stored = readSchedule(draft.schedule);
  if (!stored) return { outcome: 'reject', reason: 'invalid-schedule' };
  if (stored.kind === 'one-shot' && stored.fireAt <= now) {
    const parts = zonedParts(draft.timezone, stored.fireAt);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return { outcome: 'reject', reason: 'past-time', clock: `${pad(parts.hour)}:${pad(parts.minute)}` };
  }
  const parsed = parseSchedule(stored, { taskType: draft.taskType, now });
  if (!parsed.ok) {
    if (parsed.reason === 'lead-too-soon' && hasRemainingFire(stored, now)) {
      return { outcome: 'confirm', schedule: stored };
    }
    return { outcome: 'reject', reason: parsed.reason };
  }
  if (!hasRemainingFire(parsed.schedule, now)) {
    return { outcome: 'reject', reason: 'no-remaining-fires' };
  }
  return { outcome: 'confirm', schedule: parsed.schedule };
}

async function settleDraftCardFailure(
  ctx: {
    channel: CommandContext['channel'];
    automations?: AutomationsStore;
    automationsScheduler?: CommandContext['automationsScheduler'];
    chatMode: CommandContext['chatMode'];
    msg: { chatId: string; messageId?: string; threadId?: string };
  },
  draft: AutomationDraft,
  error: unknown,
  replyTo: string,
): Promise<void> {
  if (await abandonIfNotInChat(error, draft.chatId, (chatId) => ctx.automationsScheduler?.removeFromChat(chatId))) {
    return;
  }
  if (isNotInChat(error)) throw error;
  if (draftConfirmationDelivery(ctx.automations?.getDraft(draft.draftId)).state === 'sending') return;
  const kind = classify(error);
  const { code } = readCardApiError(error);
  switch (kind) {
    case 'link':
      log.info('auto', 'draft.card-deferred', {
        draftId: draft.draftId,
        ...(code !== undefined ? { code } : {}),
      });
      return;
    case 'rejected':
    case 'local': {
      const notice = await replyDraftCardFailed(ctx, replyTo, code);
      if (notice === 'deferred') {
        log.info('auto', 'draft.card-deferred', {
          draftId: draft.draftId,
          ...(code !== undefined ? { code } : {}),
        });
        return;
      }
      await ctx.automations?.takeDraft(draft.draftId);
      log.warn('auto', 'draft.card-failed', {
        draftId: draft.draftId,
        ...(code !== undefined ? { code } : {}),
      });
      return;
    }
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

async function replyDraftCardFailed(
  ctx: {
    channel: CommandContext['channel'];
    automationsScheduler?: CommandContext['automationsScheduler'];
    chatMode: CommandContext['chatMode'];
    msg: { chatId: string; threadId?: string };
  },
  replyTo: string,
  code: number | undefined,
): Promise<'sent' | 'deferred' | 'dropped'> {
  const shown = code === undefined ? 'unknown' : String(code);
  const markdown = `确认卡片发送失败（飞书错误 ${shown}），未创建任务。请稍后重试。`;
  try {
    await ctx.channel.send(
      ctx.msg.chatId,
      { markdown },
      {
        ...(replyTo ? { replyTo } : {}),
        ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true } : {}),
      },
    );
    return 'sent';
  } catch (err) {
    if (await abandonIfNotInChat(err, ctx.msg.chatId, (chatId) => ctx.automationsScheduler?.removeFromChat(chatId))) {
      return 'dropped';
    }
    if (isNotInChat(err)) throw err;
    if (classify(err) === 'link') return 'deferred';
    log.warn('auto', 'reply-failed', { err: err instanceof Error ? err.message : String(err) });
    return 'dropped';
  }
}

function signEndTokens(auth: AutoActionAuth, draft: AutomationDraft): EndCardTokens {
  const sign = (action: AutoCardAction): string => auth.sign({
    draftId: draft.draftId,
    chatId: draft.chatId,
    action,
    ttlMs: AUTO_CARD_TTL_MS,
  });
  return {
    'auto.end.1w': sign('auto.end.1w'),
    'auto.end.2w': sign('auto.end.2w'),
    'auto.end.1m': sign('auto.end.1m'),
    'auto.end.3m': sign('auto.end.3m'),
    'auto.end.eoy': sign('auto.end.eoy'),
    'auto.end.1y': sign('auto.end.1y'),
    'auto.end.custom': sign('auto.end.custom'),
    'auto.reject': sign('auto.reject'),
  };
}


/** Persist submission before attempting any external card delivery. */
export async function submitDraft(ctx: DraftConfirmationContext, input: SaveAutomationDraftInput, operation?: RegisterAutomationOperationInput): Promise<AutomationDraft> {
  if (!ctx.automations) throw new Error('Automation confirmations unavailable');
  const staleDrafts = ctx.automations.listDrafts().filter(draft => draft.op === 'create' && input.op !== 'delete'
    && draft.createdBy === input.createdBy && draft.chatId === input.chatId && draft.name.trim() === input.name.trim());
  const prior = operation?.supersedesOperationId ? ctx.automations.getOperation(operation.supersedesOperationId) : undefined;
  const explicit = prior ? ctx.automations.getOperationDraft(prior.draftId) : undefined;
  if (explicit && !staleDrafts.some(draft => draft.draftId === explicit.draftId)) staleDrafts.push(explicit);
  const draft = await ctx.automations.saveDraft(input, operation);
  for (const old of staleDrafts) {
    if (cardDraft(old).cardMessageId && !ctx.automations.getDraft(old.draftId)) scheduleDraftCardSettle(ctx.channel, old, DRAFT_SETTLED_SUPERSEDED);
  }
  await flushDraftConfirmations(ctx, draft.draftId);
  return draft;
}

export async function flushDraftConfirmations(ctx: DraftConfirmationContext, draftId?: string): Promise<void> {
  if (draftId) await flushDraftCardOnce(ctx, draftId, (ctx.now ?? Date.now)());
  else await flushPendingDraftCards(ctx);
}

export interface DraftActionInput {
  action: AutoCardAction;
  token: string;
  chatId: string;
  messageId: string;
  customText?: string;
}
export interface DraftActionResult { ok: boolean; message: string }
const activeActions = new WeakMap<AutomationsStore, Set<string>>();

/** Registration, token verification and the durable transition share one owner. */
export async function handleDraftAction(ctx: DraftConfirmationContext, input: DraftActionInput): Promise<DraftActionResult> {
  const invalid = { ok: false, message: AUTO_INVALID_HINT };
  const store = ctx.automations;
  const auth = ctx.autoAuth;
  if (!store || !auth) return invalid;
  const draft = store.findDraftByCardMessageId(input.messageId);
  if (!draft || draft.chatId !== input.chatId || draft.createdAt + AUTOMATIONS_DRAFT_TTL_MS <= (ctx.now ?? Date.now)()) return invalid;
  const verified = auth.verify(input.token, { chatId: input.chatId, draftId: draft.draftId, action: input.action });
  if (!verified.ok) return invalid;
  const nonce = verified.payload.nonce;
  let active = activeActions.get(store);
  if (!active) { active = new Set(); activeActions.set(store, active); }
  if (active.has(draft.draftId) || !auth.claimNonce(nonce)) return isAutoEndAction(input.action) ? { ok: false, message: AUTO_END_BUSY } : invalid;
  active.add(draft.draftId);
  try {
    if (isAutoEndAction(input.action)) {
      if (draft.op === 'delete') return invalid;
      const endAt = resolveEndAt(input.action, { timezone: draft.timezone, now: (ctx.now ?? Date.now)(), startAt: draft.startAt, customText: input.customText });
      if (endAt === undefined) return { ok: false, message: AUTO_INVALID_END };
      const result = await completeDraftEnd({ ...ctx, automations: store, autoAuth: auth }, draft, endAt, input.messageId);
      if (!result.ok) return { ok: false, message: result.message };
      auth.consume(nonce);
      scheduleDraftCardSettle(ctx.channel, draft, DRAFT_SETTLED_END_CHOSEN, store);
      return { ok: true, message: DRAFT_SETTLED_END_CHOSEN };
    }
    if (input.action === 'auto.reject') {
      if (!await store.takeDraft(draft.draftId)) return invalid;
      auth.consume(nonce);
      log.info('auto', 'rejected', { draftId: draft.draftId, chatId: draft.chatId, source: 'confirm-card' });
      scheduleDraftCardSettle(ctx.channel, draft, DRAFT_SETTLED_CANCELLED, store);
      return { ok: true, message: DRAFT_SETTLED_CANCELLED };
    }
    const result = await confirmAutomationDraft(ctx, draft);
    // Failed validations also close the confirmation, as the old taken-draft path did.
    if (!result.ok) await store.takeDraft(draft.draftId);
    auth.consume(nonce);
    scheduleDraftCardSettle(ctx.channel, draft, result.status, store);
    return { ok: result.ok, message: result.toast };
  } finally {
    active.delete(draft.draftId);
    auth.releaseNonce(nonce);
  }
}

/** A receipt is observable; the card body and update sequence remain private. */
export function draftConfirmationDelivery(draft: AutomationDraft | undefined) {
  const card = draft ? cardDraft(draft) : undefined;
  return { messageId: card?.cardMessageId, state: card?.delivery?.state };
}
export { expireDueDraftCards as expireDraftConfirmations } from './draft-confirmation/settlement';
export function nextDraftConfirmationExpiry(store: AutomationsStore): number | undefined {
  const expiries = store.listDrafts().filter(draft => Boolean(cardDraft(draft).cardMessageId)).map(draft => draft.createdAt + AUTOMATIONS_DRAFT_TTL_MS);
  return expiries.length ? Math.min(...expiries) : undefined;
}
