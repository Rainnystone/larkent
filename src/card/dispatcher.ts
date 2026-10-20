import type {
  CardActionEvent,
  CardActionResponse,
  LarkChannel,
  NormalizedMessage,
} from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import type { BackfillLedger } from '../bot/backfill-ledger';
import type { ChatModeCache } from '../bot/chat-mode-cache';
import type { PendingQueue } from '../bot/pending-queue';
import type { ProcessPool } from '../bot/process-pool';
import {
  isAutoCardAction,
  isAutoEndAction,
  type AutoActionAuth,
  type AutoCardAction,
} from '../automations/action-auth';
import type { BoardActionAuth, BoardCardAction } from '../automations/board-auth';
import {
  AUTO_END_BUSY,
  AUTO_INVALID_END,
  AUTO_BOARD_UPDATED_HINT,
  AUTO_INVALID_HINT,
  AUTO_UNKNOWN_ID,
  completeDraftEnd,
  confirmAutomationDraft,
  resolveEndAt,
} from '../automations/command';
import { cloneDraftCardBody } from '../automations/card-body';
import {
  DRAFT_SETTLED_CANCELLED,
  DRAFT_SETTLED_END_CHOSEN,
  type DraftCardRef,
  scheduleDraftCardSettle,
} from '../automations/draft-card';
import { mutateAutomationTask, taskMutationLabels } from '../automations/task-mutation';
import type { AutomationScheduler } from '../automations/scheduler';
import {
  AUTOMATIONS_DRAFT_TTL_MS,
  type AutomationItem,
  type AutomationsStore,
} from '../automations/store';
import type { CallbackAuth } from './callback-auth';
import type { Continuations } from '../bot/continuation';
import {
  type NoticeAction,
  type NoticeActionAuth,
  resolveInterruptionNotice,
} from '../bot/interruption-notice';
import type { TurnJournal, TurnJournalEntry } from '../bot/turn-journal';
import { runCommandHandler, type CommandContext, type Controls } from '../commands';
import { log } from '../core/logger';
import { evaluateAccess } from '../policy/access';
import type { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import type { ResumeCandidates } from '../session/resume-candidates';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { commandSessionCatalogIdentity } from '../bot/session-catalog-identity';
import { lookupMessageThreadId } from '../bot/thread-id';

/** Marker key on a button's value object that flags the cardAction as
 * a callback that should be forwarded back to the agent instead
 * of dispatched to a built-in command handler. The double-underscore
 * sigils make it virtually impossible to collide with normal payload
 * fields the agent might set.
 */
const BRIDGE_CALLBACK_MARKER = '__bridge_cb';
const LEGACY_CLAUDE_CALLBACK_MARKER = '__claude_cb';

export interface CardDispatchDeps {
  channel: LarkChannel;
  evt: CardActionEvent;
  sessions: SessionStore;
  resumeCandidates: ResumeCandidates;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  ledger?: BackfillLedger;
  activeRuns: ActiveRuns;
  agent: AgentAdapter;
  processPool?: ProcessPool;
  runExecutor?: RunExecutor;
  controls: Controls;
  pending: PendingQueue;
  chatModeCache: ChatModeCache;
  callbackAuth?: CallbackAuth;
  callbackPolicyFingerprint?: string;
  callbackPolicyFingerprintForScope?: (scope: string) => string | undefined;
  journal?: TurnJournal;
  noticeAuth?: NoticeActionAuth;
  autoAuth?: AutoActionAuth;
  boardAuth?: BoardActionAuth;
  automations?: AutomationsStore;
  automationsScheduler?: AutomationScheduler;
  now?: () => number;
  onAutomationConfirmed?: (item: AutomationItem) => void | Promise<void>;
  continuations?: Continuations;
  onNoticeAction?: (input: {
    action: NoticeAction;
    entry: TurnJournalEntry;
    operatorId: string;
    scope: string;
    threadId: string | undefined;
    mode: 'p2p' | 'group' | 'topic';
    messageId: string;
  }) => Promise<void> | void;
}

export async function handleCardAction(deps: CardDispatchDeps): Promise<CardActionResponse | void> {
  const startedAt = Date.now();
  const incoming = deps.evt.action.value;
  const cmd = incoming && typeof incoming === 'object' && typeof (incoming as { cmd?: unknown }).cmd === 'string'
    ? (incoming as { cmd: string }).cmd
    : '';
  log.info('cardAction', 'received', { cmd });
  try {
    return await dispatchCardAction(deps);
  } finally {
    log.info('cardAction', 'responded', { cmd, ms: Date.now() - startedAt });
  }
}

async function dispatchCardAction(deps: CardDispatchDeps): Promise<CardActionResponse | void> {
  const value = deps.evt.action.value;
  if (!value || typeof value !== 'object') return;
  const payload = value as Record<string, unknown>;

  const operatorId = deps.evt.operator.openId;
  const chatId = deps.evt.chatId;

  // CardKit 2.0 form submits drop user-input values from action.value; they
  // arrive on raw.action.form_value. The SDK forwards the raw event when
  // includeRawEvent: true is set on the channel options.
  const raw = (deps.evt as CardActionEvent & { raw?: unknown }).raw as
    | { action?: { form_value?: Record<string, unknown> } }
    | undefined;
  const formValue = raw?.action?.form_value;

  // Resolve the click's session scope. For topic groups we need to know
  // the message's thread_id so the action targets the right topic's
  // session — look up the carrier message (the card lives on it) once.
  // Done before the access check so we know the chat mode (p2p vs group)
  // and can skip the chat allowlist for DMs.
  const { scope, threadId, mode } = await resolveScope(deps);

  const accessDecision = evaluateAccess({
    entry: 'card',
    profile: deps.controls.profileConfig,
    controls: deps.controls,
    chatId,
    senderId: operatorId,
    chatMode: mode === 'p2p' ? 'p2p' : 'group',
  });
  if (!accessDecision.ok) {
    log.info('cardAction', 'skip-not-allowed-user', {
      operator: operatorId.slice(-6),
      reason: accessDecision.reason,
    });
    return;
  }

  if (LEGACY_CLAUDE_CALLBACK_MARKER in payload) {
    log.info('cardAction', 'skip-legacy-callback-marker', { scope });
    return;
  }

  const cmd = typeof payload.cmd === 'string' ? payload.cmd : '';
  if (cmd === 'notice.continue' || cmd === 'notice.dismiss') {
    await dispatchNoticeAction(deps, payload, cmd, scope, threadId, mode, accessDecision);
    return;
  }
  if (isAutoCardAction(cmd)) {
    return dispatchAutoAction(deps, payload, cmd, accessDecision, formValue);
  }
  if (cmd === 'auto.pause' || cmd === 'auto.resume' || cmd === 'auto.delete') {
    return dispatchBoardAction(deps, payload, cmd, accessDecision);
  }
  if (cmd) {
    if (isSignedBridgeCallback(payload) && !verifyBridgeToken(deps, payload, scope, cmd)) {
      return;
    }
    log.info('cardAction', 'cmd', { cmd, scope });
    const msg = makeFakeMsg(deps.evt, threadId);

    const ctx: CommandContext = {
      channel: deps.channel,
      msg,
      scope,
      chatMode: mode,
      sessions: deps.sessions,
      resumeCandidates: deps.resumeCandidates,
      sessionCatalog: deps.sessionCatalog,
      sessionCatalogIdentity: await commandSessionCatalogIdentity({
        msg,
        scope,
        mode,
        workspaces: deps.workspaces,
        controls: deps.controls,
        access: accessDecision,
      }),
      workspaces: deps.workspaces,
      ledger: deps.ledger,
      activeRuns: deps.activeRuns,
      agent: deps.agent,
      processPool: deps.processPool,
      runExecutor: deps.runExecutor,
      controls: deps.controls,
      formValue,
      fromCardAction: true,
    };

    const [name, ...rest] = cmd.split('.');
    const sub = rest.join(' ');
    const args = composeArgs(sub, payload);

    try {
      const ok = await runCommandHandler(name ?? '', args, ctx);
      if (!ok) log.warn('cardAction', 'unknown', { cmd });
    } catch (err) {
      log.fail('cardAction', err, { cmd });
    }
    return;
  }

  // Agent-driven callback: the button was rendered by an agent via lark-cli,
  // with `__bridge_cb` set on the value. Forward the click back into the
  // scope's pending queue so the agent resumes its session and sees the click
  // as a follow-up message, with full context of what it sent.
  if (BRIDGE_CALLBACK_MARKER in payload) {
    if (!verifyBridgeToken(deps, payload, scope, 'agent_callback')) return;
    forwardToAgent(deps, payload, formValue, scope, threadId, mode);
    return;
  }

  return;
}

async function resolveScope(
  deps: CardDispatchDeps,
): Promise<{ scope: string; threadId: string | undefined; mode: 'p2p' | 'group' | 'topic' }> {
  const chatId = deps.evt.chatId;
  const mode = await deps.chatModeCache.resolve(deps.channel, chatId);
  if (mode !== 'topic') {
    return { scope: chatId, threadId: undefined, mode };
  }
  // Topic group — need the carrier message's thread_id to compose scope.
  // One API call per click; could cache by messageId if it ever becomes hot.
  const threadId = await lookupMessageThreadId(deps.channel, deps.evt.messageId);
  if (!threadId) {
    // Fall back to plain chatId. Better to land in the chat's "default"
    // scope than fail the click silently.
    return { scope: chatId, threadId: undefined, mode };
  }
  return { scope: `${chatId}:${threadId}`, threadId, mode };
}

function forwardToAgent(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  formValue: Record<string, unknown> | undefined,
  scope: string,
  threadId: string | undefined,
  mode: 'p2p' | 'group' | 'topic',
): void {
  // Strip the marker so the agent only sees the meaningful fields it set.
  const {
    [BRIDGE_CALLBACK_MARKER]: _marker,
    bridge_token: _token,
    ...agentPayload
  } = payload;
  const merged = formValue ? { ...agentPayload, form_value: formValue } : agentPayload;
  log.info('cardAction', 'forward-agent', {
    scope,
    payload: JSON.stringify(merged).slice(0, 200),
  });
  const synthetic: NormalizedMessage = {
    messageId: deps.evt.messageId,
    chatId: deps.evt.chatId,
    chatType: mode === 'p2p' ? 'p2p' : 'group',
    threadId,
    senderId: deps.evt.operator.openId,
    senderName: deps.evt.operator.name,
    content: `[card-click] ${JSON.stringify(merged)}`,
    rawContentType: 'card_action',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
  deps.pending.push(scope, synthetic);
}

function verifyBridgeToken(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  scope: string,
  action: string,
): boolean {
  const token = typeof payload.bridge_token === 'string' ? payload.bridge_token : '';
  const active = deps.activeRuns.get(scope);
  if (!deps.callbackAuth || !token || !active) {
    log.info('cardAction', 'skip-callback-auth-missing', { scope, action });
    log.warn('callback', 'denied', { scope, action, reason: 'missing-token-or-run' });
    return false;
  }
  const result = deps.callbackAuth.verify(token, {
    runId: active.run.runId,
    scope,
    chatId: deps.evt.chatId,
    operatorOpenId: deps.evt.operator.openId,
    action,
    policyFingerprint:
      deps.callbackPolicyFingerprintForScope?.(scope) ??
      deps.callbackPolicyFingerprint ??
      '',
  });
  if (!result.ok) {
    log.info('cardAction', 'skip-callback-auth-failed', {
      scope,
      action,
      reason: result.reason,
    });
    log.warn('callback', 'denied', { scope, action, reason: result.reason });
    return false;
  }
  return true;
}

async function dispatchNoticeAction(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  cmd: NoticeAction,
  scope: string,
  threadId: string | undefined,
  mode: 'p2p' | 'group' | 'topic',
  access: ReturnType<typeof evaluateAccess>,
): Promise<void> {
  if (!access.ok) return;
  const token = typeof payload.notice_token === 'string' ? payload.notice_token : '';
  if (!deps.noticeAuth || !token) {
    log.info('cardAction', 'skip-notice-auth-missing', { scope, cmd });
    await sendNoticeInvalid(deps);
    return;
  }
  const verified = deps.noticeAuth.verify(token);
  if (!verified.ok || verified.payload.action !== cmd) {
    log.info('cardAction', 'skip-notice-auth-failed', {
      scope,
      cmd,
      reason: verified.ok ? 'action-mismatch' : verified.reason,
    });
    await sendNoticeInvalid(deps);
    return;
  }
  if (verified.payload.scope !== scope || verified.payload.chatId !== deps.evt.chatId) {
    await sendNoticeInvalid(deps);
    return;
  }
  const entry = deps.journal?.get(verified.payload.turnId);
  if (!entry || entry.noticeInvalidated || entry.status === 'voided') {
    await sendNoticeInvalid(deps);
    return;
  }
  if (entry.policyFingerprint && entry.policyFingerprint !== verified.payload.policyFingerprint) {
    await sendNoticeInvalid(deps);
    return;
  }
  const identity = await commandSessionCatalogIdentity({
    msg: makeFakeMsg(deps.evt, threadId),
    scope,
    mode,
    workspaces: deps.workspaces,
    controls: deps.controls,
    access,
  });
  if (identity && identity.policyFingerprint !== verified.payload.policyFingerprint) {
    await sendNoticeInvalid(deps);
    return;
  }
  if (cmd === 'notice.continue' && deps.continuations && !deps.continuations.click(entry.turnId)) {
    await sendNoticeInvalid(deps);
    return;
  }
  if (cmd === 'notice.dismiss') {
    if (deps.continuations) deps.continuations.dismiss(entry.turnId);
    else deps.journal?.invalidateNotice(entry.turnId);
    if (deps.journal) {
      await resolveInterruptionNotice({
        journal: deps.journal,
        turnId: entry.turnId,
        resolution: 'dismissed',
        updateCard: (id, card) => deps.channel.updateCard(id, card),
      });
    }
    log.info('notice', 'dismissed', { turnId: entry.turnId, scope });
    return;
  }
  await deps.onNoticeAction?.({
    action: cmd,
    entry,
    operatorId: deps.evt.operator.openId,
    scope,
    threadId,
    mode,
    messageId: deps.evt.messageId,
  });
}

async function dispatchAutoAction(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  cmd: AutoCardAction,
  access: ReturnType<typeof evaluateAccess>,
  formValue?: Record<string, unknown>,
): Promise<CardActionResponse | void> {
  if (!access.ok) return;
  const botOpenId = deps.channel.botIdentity?.openId;
  if (botOpenId && deps.evt.operator.openId === botOpenId) {
    return actionToast('error', AUTO_INVALID_HINT);
  }
  const token = typeof payload.auto_token === 'string' ? payload.auto_token : '';
  if (!deps.autoAuth || !deps.automations || !token) {
    log.info('cardAction', 'skip-auto-auth-missing', { cmd });
    return actionToast('error', AUTO_INVALID_HINT);
  }
  const registered = deps.automations.findDraftByCardMessageId(deps.evt.messageId);
  if (!registered) {
    log.info('cardAction', 'skip-auto-unregistered', { cmd, messageId: deps.evt.messageId });
    return actionToast('error', AUTO_INVALID_HINT);
  }
  if (!deps.controls.profileConfig.automations.enabled) {
    return actionToast('error', AUTO_INVALID_HINT);
  }
  const verified = deps.autoAuth.verify(token, { consume: !isAutoEndAction(cmd) && !registered.operationId });
  if (!verified.ok || verified.payload.action !== cmd) {
    log.info('cardAction', 'skip-auto-auth-failed', {
      cmd,
      reason: verified.ok ? 'action-mismatch' : verified.reason,
    });
    return actionToast('error', AUTO_INVALID_HINT);
  }
  if (
    verified.payload.chatId !== deps.evt.chatId
    || verified.payload.draftId !== registered.draftId
  ) {
    return actionToast('error', AUTO_INVALID_HINT);
  }
  const now = (deps.now ?? Date.now)();
  if (registered.createdAt + AUTOMATIONS_DRAFT_TTL_MS <= now) {
    return actionToast('error', AUTO_INVALID_HINT);
  }
  if (isAutoEndAction(cmd)) {
    if (registered.op === 'delete') return actionToast('error', AUTO_INVALID_HINT);
    const snapshot = draftCardRef(registered);
    const nonce = verified.payload.nonce;
    if (!deps.autoAuth.claimNonce(nonce)) {
      return actionToast('error', AUTO_END_BUSY);
    }
    let failure: string | undefined;
    try {
      const customText = readEndInput(payload, formValue);
      const endAt = resolveEndAt(cmd, {
        timezone: registered.timezone,
        now,
        startAt: registered.startAt,
        ...(customText ? { customText } : {}),
      });
      if (endAt === undefined) {
        failure = AUTO_INVALID_END;
      } else {
        const result = await completeDraftEnd({
          automations: deps.automations,
          autoAuth: deps.autoAuth,
          automationsScheduler: deps.automationsScheduler,
          channel: deps.channel,
          now: deps.now,
        }, registered, endAt, deps.evt.messageId);
        if (!result.ok) failure = result.message;
        else if (!deps.autoAuth.consume(nonce)) failure = AUTO_INVALID_HINT;
      }
    } finally {
      deps.autoAuth.releaseNonce(nonce);
    }
    if (failure) return actionToast('error', failure);
    scheduleDraftCardSettle(deps.channel, snapshot, DRAFT_SETTLED_END_CHOSEN, deps.automations);
    return actionToast('success', DRAFT_SETTLED_END_CHOSEN);
  }

  if (registered.operationId && cmd === 'auto.confirm') {
    if (!deps.autoAuth.claimNonce(verified.payload.nonce)) return actionToast('error', AUTO_INVALID_HINT);
    try {
      const result = await confirmAutomationDraft({ automations: deps.automations, automationsScheduler: deps.automationsScheduler, onAutomationConfirmed: deps.onAutomationConfirmed, now: deps.now }, registered);
      if (result.ok) deps.autoAuth.consume(verified.payload.nonce);
      scheduleDraftCardSettle(deps.channel, registered, result.status);
      return actionToast(result.ok ? 'success' : 'error', result.toast);
    } finally { deps.autoAuth.releaseNonce(verified.payload.nonce); }
  }
  const taken = await deps.automations.takeDraft(registered.draftId);
  if (!taken) {
    return actionToast('error', AUTO_INVALID_HINT);
  }
  switch (cmd) {
    case 'auto.reject':
      if (taken.operationId) deps.autoAuth.consume(verified.payload.nonce);
      log.info('auto', 'rejected', {
        draftId: taken.draftId,
        chatId: taken.chatId,
        source: 'confirm-card',
      });
      scheduleDraftCardSettle(deps.channel, taken, DRAFT_SETTLED_CANCELLED);
      return actionToast('success', DRAFT_SETTLED_CANCELLED);
    case 'auto.confirm': {
      const result = await confirmAutomationDraft({
        automations: deps.automations,
        automationsScheduler: deps.automationsScheduler,
        onAutomationConfirmed: deps.onAutomationConfirmed,
        now: deps.now,
      }, taken);
      scheduleDraftCardSettle(deps.channel, taken, result.status);
      return actionToast(result.ok ? 'success' : 'error', result.toast);
    }
    default: {
      const _exhaustive: never = cmd;
      return _exhaustive;
    }
  }
}

async function dispatchBoardAction(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  cmd: BoardCardAction,
  access: ReturnType<typeof evaluateAccess>,
): Promise<CardActionResponse | void> {
  if (!access.ok) return;
  const botOpenId = deps.channel.botIdentity?.openId;
  if (botOpenId && deps.evt.operator.openId === botOpenId) {
    return actionToast('error', AUTO_INVALID_HINT);
  }
  const token = typeof payload.auto_token === 'string' ? payload.auto_token : '';
  if (!deps.boardAuth || !deps.automations || !deps.automationsScheduler || !token) {
    return actionToast('error', AUTO_INVALID_HINT);
  }
  if (!deps.controls.profileConfig.automations.enabled) {
    return actionToast('error', AUTO_INVALID_HINT);
  }
  const verified = deps.boardAuth.verify(token);
  if (!verified.ok || verified.payload.action !== cmd) {
    return actionToast('error', AUTO_INVALID_HINT);
  }
  const registered = deps.automations.findBoardByMessageId(deps.evt.messageId);
  if (!registered || registered.messageId !== deps.evt.messageId) {
    return actionToast('error', AUTO_BOARD_UPDATED_HINT);
  }
  if (
    verified.payload.chatId !== deps.evt.chatId
    || verified.payload.chatId !== registered.chatId
  ) {
    return actionToast('error', AUTO_INVALID_HINT);
  }
  const operation = cmd === 'auto.pause' ? 'pause' : cmd === 'auto.resume' ? 'resume' : 'delete';
  const id = verified.payload.itemId;
  const result = await mutateAutomationTask({ store: deps.automations, scheduler: deps.automationsScheduler, chatId: registered.chatId, now: deps.now }, operation, id);
  if (!result.ok) return actionToast('error', AUTO_UNKNOWN_ID);
  log.info('auto', { pause: 'paused', resume: 'resumed', delete: 'deleted' }[operation], { id });
  return actionToast('success', `已${taskMutationLabels[operation]} #${id}`);
}

function actionToast(type: 'success' | 'error', content: string): CardActionResponse {
  return { toast: { type, content } };
}

function draftCardRef(draft: DraftCardRef): DraftCardRef {
  return {
    draftId: draft.draftId,
    ...(draft.cardMessageId ? { cardMessageId: draft.cardMessageId } : {}),
    ...(draft.cardId ? { cardId: draft.cardId } : {}),
    ...(draft.sequence !== undefined ? { sequence: draft.sequence } : {}),
    ...(draft.cardBody ? { cardBody: cloneDraftCardBody(draft.cardBody) } : {}),
  };
}

function readEndInput(
  payload: Record<string, unknown>,
  formValue: Record<string, unknown> | undefined,
): string | undefined {
  const fromForm = formValue?.end_at;
  if (typeof fromForm === 'string' && fromForm.trim()) return fromForm.trim();
  const fromPayload = payload.end_at;
  if (typeof fromPayload === 'string' && fromPayload.trim()) return fromPayload.trim();
  return undefined;
}

async function sendNoticeInvalid(deps: CardDispatchDeps): Promise<void> {
  try {
    await deps.channel.send(deps.evt.chatId, { markdown: '此继续已失效。' }, { replyTo: deps.evt.messageId });
  } catch (error) {
    log.warn('notice', 'invalid-hint-failed', {
      err: error instanceof Error ? error.message : String(error),
    });
  }
}

function isSignedBridgeCallback(payload: Record<string, unknown>): boolean {
  return BRIDGE_CALLBACK_MARKER in payload || typeof payload.bridge_token === 'string';
}

/** Turn a button payload like {cmd:'ws.use', name:'proj-a'} into the arg
 * string the text-command handler expects: 'use proj-a'. Accepts `arg`
 * (preferred, generic) or `name` (legacy ws cards). */
function composeArgs(sub: string, payload: Record<string, unknown>): string {
  if (!sub) return '';
  const arg =
    (typeof payload.arg === 'string' && payload.arg) ||
    (typeof payload.name === 'string' && payload.name) ||
    '';
  return arg ? `${sub} ${arg}` : sub;
}

function makeFakeMsg(
  evt: CardActionEvent,
  threadId: string | undefined,
): NormalizedMessage {
  return {
    messageId: evt.messageId,
    chatId: evt.chatId,
    chatType: 'p2p',
    threadId,
    senderId: evt.operator.openId,
    senderName: evt.operator.name,
    content: '',
    rawContentType: 'interactive',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}
