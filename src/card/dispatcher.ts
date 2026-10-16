import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import type { BackfillLedger } from '../bot/backfill-ledger';
import type { ChatModeCache } from '../bot/chat-mode-cache';
import type { PendingQueue } from '../bot/pending-queue';
import type { ProcessPool } from '../bot/process-pool';
import type { CallbackAuth } from './callback-auth';
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

export async function handleCardAction(deps: CardDispatchDeps): Promise<void> {
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
  if (cmd === 'notice.dismiss') {
    deps.journal?.update(entry.turnId, { noticeInvalidated: true });
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
