import { reconcileDraftCard, sendAutomationDraftCard } from './draft-delivery';
import { log } from '../core/logger';
import { classify, isNotInChat } from '../bot/feishu-error';
import { readCardApiError } from '../card/card-api-error';
import { abandonIfNotInChat } from './chat-lifecycle';
import type { CommandContext } from '../commands';
import { AUTO_CARD_TTL_MS, type AutoActionAuth, type AutoCardAction } from './action-auth';
import { automationConfirmCard, automationDeleteCard, automationReplaceCard } from './confirm-card';
import { automationEndCard, type EndCardTokens } from './end-card';
import { nextFireAfter, parseSchedule, readSchedule, type Schedule } from './schedule';
import { zonedParts } from './zoned-time';
import { draftConfirmedStatus, draftDeletedStatus, draftReplacedStatus, draftSameNameExistsStatus, draftTargetGoneStatus, draftTargetChangedStatus, DRAFT_SETTLED_CANCELLED } from './draft-card';
import { taskMutationError, type AutomationDraft, type AutomationItem, type AutomationsStore, type DeleteAutomationDraft, type ReplaceAutomationDraft, type SaveAutomationDraftInput, type RegisterAutomationOperationInput } from './store';
import { AUTO_INVALID_HINT, AUTO_END_NOT_AFTER_START, AUTO_NO_REMAINING_FIRES, AUTO_AGENT_NEEDS_CWD, assessAutomationSchedule, hasRemainingFire, noteAutomationRejected, rejectMessage, completePendingSchedule, presetEndAt, parseEndAtText, scheduleStartAt, scheduleEndAt, type AutomationScheduleVerdict } from './command-schedule';
export type DraftFlushContext = {
  botAppId?: string;
  channel: CommandContext['channel'];
  automations?: AutomationsStore;
  autoAuth?: AutoActionAuth;
  automationsScheduler?: CommandContext['automationsScheduler'];
  now?: () => number;
  isLinkDown?: () => boolean;
};

/** In-flight card claim per draft. Bind happens after send, so a second flush must wait. */
const draftCardClaims = new Map<string, Promise<void>>();

export async function flushPendingDraftCards(ctx: DraftFlushContext): Promise<void> {
  if (!ctx.automations || !ctx.autoAuth || ctx.isLinkDown?.()) return;
  const now = (ctx.now ?? Date.now)();
  for (const draft of ctx.automations.listDrafts()) {
    if (draft.cardMessageId) continue;
    try {
      await flushDraftCardOnce(ctx, draft.draftId, now);
    } catch (error) {
      log.fail('auto', error, { event: 'draft.flush', draftId: draft.draftId });
    }
  }
}

export async function flushDraftCardOnce(ctx: DraftFlushContext, draftId: string, now: number): Promise<void> {
  const automations = ctx.automations;
  if (!automations || !ctx.autoAuth || ctx.isLinkDown?.()) return;
  for (;;) {
    const inflight = draftCardClaims.get(draftId);
    if (inflight) {
      await inflight;
      continue;
    }
    const draft = automations.getDraft(draftId);
    if (!draft || draft.cardMessageId) return;
    if (draft.delivery?.state === 'sending') { await reconcileDraftCard(ctx.channel, automations, draft, ctx.botAppId); return; }
    if (draft.operationId && draft.delivery?.state === 'rejected') return;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    draftCardClaims.set(draftId, gate);
    try {
      await deliverUnboundDraftCard(ctx, draft, now);
    } finally {
      if (draftCardClaims.get(draftId) === gate) draftCardClaims.delete(draftId);
      release();
    }
    return;
  }
}

async function deliverUnboundDraftCard(
  ctx: DraftFlushContext,
  draft: AutomationDraft,
  now: number,
): Promise<void> {
  if (!ctx.automations || !ctx.autoAuth) return;
  const cardCtx = {
    channel: ctx.channel,
    automations: ctx.automations,
    autoAuth: ctx.autoAuth,
    automationsScheduler: ctx.automationsScheduler,
    chatMode: draft.cardReply?.replyInThread ? 'topic' as const : 'group' as const,
    msg: { chatId: draft.chatId, messageId: draft.cardReply?.replyTo ?? '', threadId: draft.cardReply?.threadId },
  };
  switch (draft.op) {
    case 'delete':
      await postDeleteCard(cardCtx, draft);
      return;
    case 'create':
    case 'replace':
      if (draft.pendingRecurring) {
        await postEndCard(cardCtx, draft);
        return;
      }
      {
        const schedule = readSchedule(draft.schedule);
        if (!schedule) return;
        await postConfirmCard(cardCtx, draft, schedule, now, cardCtx.msg.messageId);
      }
      return;
    default: {
      const _exhaustive: never = draft;
      return _exhaustive;
    }
  }
}

export async function completeDraftEnd(
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
    cardMessageId: null,
    ...(draft.operationId || draft.cardReply ? { cardReply: { ...(draft.cardReply ?? {}), replyTo } } : {}),
  });
  if (!updated || updated.op === 'delete') return { ok: false, message: AUTO_INVALID_HINT };
  if (updated.operationId) {
    await flushDraftCardOnce(ctx, updated.draftId, now);
    return { ok: true };
  }
  await postConfirmCard({
    channel: ctx.channel,
    automations: ctx.automations,
    autoAuth: ctx.autoAuth,
    automationsScheduler: ctx.automationsScheduler,
    chatMode: updated.cardReply?.replyInThread ? 'topic' : ctx.chatMode ?? 'group',
    msg: { chatId: draft.chatId, threadId: updated.cardReply?.threadId },
  }, updated, parsed.schedule, now, replyTo);
  return { ok: true };
}

export function resolveEndAt(
  action: AutoCardAction,
  input: { timezone: string; now: number; startAt?: number; customText?: string },
): number | undefined {
  switch (action) {
    case 'auto.end.1w':
    case 'auto.end.2w':
    case 'auto.end.1m':
    case 'auto.end.3m':
    case 'auto.end.eoy':
    case 'auto.end.1y':
      return presetEndAt(action, input.timezone, input.now, input.startAt ?? input.now);
    case 'auto.end.custom':
      return input.customText ? parseEndAtText(input.customText, input.timezone) : undefined;
    case 'auto.confirm':
    case 'auto.reject':
      return undefined;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

export interface AutomationConfirmOutcome {
  ok: boolean;
  status: string;
  toast: string;
}

export async function confirmAutomationDraft(
  ctx: Pick<CommandContext, 'automations' | 'automationsScheduler' | 'onAutomationConfirmed'> & {
    now?: () => number;
  },
  draft: AutomationDraft,
): Promise<AutomationConfirmOutcome> {
  if (draft.op !== 'create' && ctx.automations) {
    const code = taskMutationError(ctx.automations.get(draft.targetId), { chatId: draft.chatId, revision: draft.target.revision });
    if (code) {
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
  const item = ctx.automations.get(draft.targetId);
  if (!item || item.chatId !== draft.chatId) {
    const status = draftTargetGoneStatus(draft.targetId);
    return { ok: false, status, toast: status };
  }
  const ok = await ctx.automationsScheduler.delete(draft.targetId, { chatId: draft.chatId, revision: draft.target.revision, operationId: draft.operationId });
  if (!ok) {
    const code = taskMutationError(ctx.automations.get(draft.targetId), { chatId: draft.chatId, revision: draft.target.revision }) ?? 'target-not-found';
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
    created = await ctx.automations.replace(draft, {
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
    });
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

async function postEndCard(
  ctx: {
    channel: CommandContext['channel'];
    automations?: AutomationsStore;
    autoAuth?: AutoActionAuth;
    automationsScheduler?: CommandContext['automationsScheduler'];
    chatMode: CommandContext['chatMode'];
    msg: { chatId: string; messageId?: string; threadId?: string };
  },
  draft: Exclude<AutomationDraft, DeleteAutomationDraft>,
): Promise<void> {
  if (!ctx.automations || !ctx.autoAuth) return;
  const tokens = signEndTokens(ctx.autoAuth, draft);
  const card = automationEndCard(tokens);
  try {
    await sendAutomationDraftCard(ctx.channel, ctx.automations, draft, card, {
      replyTo: ctx.msg.messageId,
      ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true, threadId: ctx.msg.threadId } : {}),
    });
  } catch (error) {
    if (draft.operationId) {
      await abandonIfNotInChat(error, draft.chatId, chatId => ctx.automationsScheduler?.removeFromChat(chatId));
      throw error;
    }
    await settleDraftCardFailure(ctx, draft, error, ctx.msg.messageId ?? '');
    return;
  }
}

async function postConfirmCard(
  ctx: {
    channel: CommandContext['channel'];
    automations?: AutomationsStore;
    autoAuth?: AutoActionAuth;
    automationsScheduler?: CommandContext['automationsScheduler'];
    chatMode: CommandContext['chatMode'];
    msg: { chatId: string; threadId?: string };
  },
  draft: Exclude<AutomationDraft, DeleteAutomationDraft>,
  schedule: Schedule,
  now: number,
  replyTo: string,
): Promise<void> {
  if (!ctx.automations || !ctx.autoAuth) return;
  if (!hasRemainingFire(schedule, now)) {
    try {
      await ctx.channel.send(
        ctx.msg.chatId,
        { markdown: AUTO_NO_REMAINING_FIRES },
        {
          ...(replyTo ? { replyTo } : {}),
          ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true } : {}),
        },
      );
    } catch (error) {
      if (await abandonIfNotInChat(error, ctx.msg.chatId, (chatId) => ctx.automationsScheduler?.removeFromChat(chatId))) {
        return;
      }
      if (classify(error) === 'link') return;
      log.warn('auto', 'reply-failed', { err: error instanceof Error ? error.message : String(error) });
    }
    await ctx.automations.takeDraft(draft.draftId);
    noteAutomationRejected('no-remaining-fires', 'command');
    return;
  }
  const confirmToken = ctx.autoAuth.sign({
    draftId: draft.draftId,
    chatId: draft.chatId,
    action: 'auto.confirm',
    ttlMs: AUTO_CARD_TTL_MS,
  });
  const rejectToken = ctx.autoAuth.sign({
    draftId: draft.draftId,
    chatId: draft.chatId,
    action: 'auto.reject',
    ttlMs: AUTO_CARD_TTL_MS,
  });
  const body = {
    taskType: draft.taskType,
    name: draft.name,
    taskText: draft.taskText,
    timezone: draft.timezone,
    schedule,
    now,
    confirmToken,
    rejectToken,
    ...(draft.cwd ? { cwd: draft.cwd } : {}),
  };
  const card = draft.op === 'replace'
    ? automationReplaceCard({ ...body, target: draft.target })
    : automationConfirmCard(body);
  try {
    await sendAutomationDraftCard(ctx.channel, ctx.automations, draft, card, {
      replyTo,
      ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true, threadId: ctx.msg.threadId } : {}),
    });
  } catch (error) {
    if (draft.operationId) {
      await abandonIfNotInChat(error, draft.chatId, chatId => ctx.automationsScheduler?.removeFromChat(chatId));
      throw error;
    }
    await settleDraftCardFailure(ctx, draft, error, replyTo);
    return;
  }
}

async function postDeleteCard(
  ctx: {
    channel: CommandContext['channel'];
    automations?: AutomationsStore;
    autoAuth?: AutoActionAuth;
    automationsScheduler?: CommandContext['automationsScheduler'];
    chatMode: CommandContext['chatMode'];
    msg: { chatId: string; messageId?: string; threadId?: string };
  },
  draft: DeleteAutomationDraft,
): Promise<void> {
  if (!ctx.automations || !ctx.autoAuth) return;
  const confirmToken = ctx.autoAuth.sign({
    draftId: draft.draftId,
    chatId: draft.chatId,
    action: 'auto.confirm',
    ttlMs: AUTO_CARD_TTL_MS,
  });
  const rejectToken = ctx.autoAuth.sign({
    draftId: draft.draftId,
    chatId: draft.chatId,
    action: 'auto.reject',
    ttlMs: AUTO_CARD_TTL_MS,
  });
  const card = automationDeleteCard({
    target: draft.target,
    confirmToken,
    rejectToken,
  });
  try {
    await sendAutomationDraftCard(ctx.channel, ctx.automations, draft, card, {
      ...(ctx.msg.messageId ? { replyTo: ctx.msg.messageId } : {}),
      ...(ctx.chatMode === 'topic' && ctx.msg.threadId ? { replyInThread: true, threadId: ctx.msg.threadId } : {}),
    });
  } catch (error) {
    if (draft.operationId) {
      await abandonIfNotInChat(error, draft.chatId, chatId => ctx.automationsScheduler?.removeFromChat(chatId));
      throw error;
    }
    await settleDraftCardFailure(ctx, draft, error, ctx.msg.messageId ?? '');
    return;
  }
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
  if (ctx.automations?.getDraft(draft.draftId)?.delivery?.state === 'sending') return;
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
export async function submitDraft(ctx: DraftFlushContext, input: SaveAutomationDraftInput, operation?: RegisterAutomationOperationInput): Promise<AutomationDraft> {
  if (!ctx.automations) throw new Error('Automation confirmations unavailable');
  const draft = await ctx.automations.saveDraft(input, operation);
  await flushDraftConfirmations(ctx, draft.draftId);
  return draft;
}

export async function flushDraftConfirmations(ctx: DraftFlushContext, draftId?: string): Promise<void> {
  if (draftId) await flushDraftCardOnce(ctx, draftId, (ctx.now ?? Date.now)());
  else await flushPendingDraftCards(ctx);
}
