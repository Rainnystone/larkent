import type {
  LarkChannel,
  LarkChannelOptions,
  NormalizedMessage,
} from '@larksuite/channel';
import { createLarkChannel } from '@larksuite/channel';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { capabilityForProfile } from '../agent/capability';
import { modelLabel, normalizeModelSelection, resolveModelArg } from '../agent/models';
import {
  buildAgentPrompt,
  type BridgePromptInteractiveCard,
  type BridgePromptMention,
  type BridgePromptQuotedMessage,
  type BridgePromptTopicMessage,
} from '../agent/prompt';
import {
  cardUserMessage,
  matchCliSignature,
  NETWORK_TRANSIENT_SIGNATURES,
  noteUnclassifiedStderr,
  type CliSignature,
} from '../agent/cli-signatures';
import { descriptorFor, isAgentKind } from '../agent/registry';
import type { AgentAdapter, AgentEvent } from '../agent/types';
import { handleCardAction } from '../card/dispatcher';
import { CallbackAuth } from '../card/callback-auth';
import { CallbackNonceStore } from '../card/callback-store';
import {
  NOTICE_RESTART_GAP_MS,
  NoticeActionAuth,
  authNoticeAlreadyDelivered,
  deliverInterruptionNotice,
  planInterruptionNotice,
  resendPendingNotice,
  stageInterruptionNotice,
} from './interruption-notice';
import { createContinuations, type ContinuationTaken, type Continuations } from './continuation';
import { renderCard } from '../card/run-renderer';
import { OUTBOUND_SKIP_CLI_SENT_METRIC } from '../card/direct-im-send';
import {
  CliSelfSendTracker,
  OutboundMessageIds,
  OUTBOUND_REQUEST_TIMEOUT_MS,
  isSelfSender,
  noteInboundSkipSelf,
  outboundMessageId,
  senderTypeFromRaw,
  withOutboundTimeout,
} from './self-message';
import {
  finalizeIfRunning,
  initialState,
  markIdleTimeout,
  markInterrupted,
  markRunnerTimeout,
  reduce,
  seedRunState,
  shouldSkipFinalReply,
  type RunState,
} from '../card/run-state';
import {
  cardTerminalFromOutcome,
  deriveRunOutcome,
  formatRunOutcome,
  formatStopRequest,
  noteTerminalStop,
  runOverlappedOutage,
  shouldDeliverAgentEvent,
  type RunOutcome,
  type StopRequest,
} from './run-outcome';
import { renderText } from '../card/text-renderer';
import { commandClearsPending, tryHandleCommand, type Controls } from '../commands';
import type { AppConfig } from '../config/schema';
import {
  getAgentStopGraceMs,
  getBackfillPreferences,
  getCotMessages,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRunIdleTimeoutMs,
  getShowToolCalls,
} from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { log, reportMetric, withTrace } from '../core/logger';
import { MediaCache, type LocalAttachment } from '../media/cache';
import {
  toPolicyAttachment,
  toPromptAttachment,
} from '../media/attachment';
import { canUseDm, canUseGroup, evaluateAccess, requireMentionForChat } from '../policy/access';
import { MeetingManager } from '../meeting/manager';
import type { VcRequestClient } from '../meeting/api';
import { attachMeetingAgent, summarizeEndedMeeting } from '../meeting/orchestrator';
import type { ScopeContext } from '../policy/run-policy';
import { createOwnerRefreshController } from '../policy/owner';
import { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import { ResumeCandidates } from '../session/resume-candidates';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { ActiveRuns, noteRunEvent, type RunHandle } from './active-runs';
import {
  createBackfillRun,
  formatBackfillLatenessHint,
  type BackfillChannel,
  type BackfillMark,
} from './backfill';
import { BackfillLedger, type IntakeSource } from './backfill-ledger';
import { classify, isNotInChat, isSupersededMessageGone, rateLimitResetDelayMs } from './feishu-error';
import { createFeishuProbe, startFeishuLink } from './feishu-link';
import type { HostSleepProbe } from '../platform/host-sleep';
import { createRecovery, reviewActiveRuns, RECOVERY_RETRY_MAX_MS, type Outage } from './recovery';
import { redeliverStagedReply, withDeliveryUuid } from './feishu-delivery';
import {
  isJournalResourceType,
  noticeState,
  promiseCorrectionDeliveryKey,
  replyDeliveryKey,
  replyState,
  streamDeliveryKey,
  type TurnJournal,
  type TurnJournalEntry,
  type TurnJournalResource,
} from './turn-journal';
import { AutoActionAuth } from '../automations/action-auth';
import { BoardActionAuth } from '../automations/board-auth';
import { createAutomationBoard, type AutomationBoard } from '../automations/board';
import {
  CATCH_UP_PROMPT_MARKER,
  formatAgentFailureNotice,
  runAutomationAgentFire,
  automationScopeForReply,
} from '../automations/agent-run';
import { attachAutomationChatLifecycle } from '../automations/chat-lifecycle';
import {
  automationProposalSuffix,
  flushPendingDraftCards,
  noteAutomationRejected,
  planAutomationProposalReply,
  replaceProposalLineAfterApply,
  submitAutomationDeleteProposal,
  submitAutomationProposal,
  submitAutomationReplaceProposal,
  type AutomationProposalVerdict,
  type RejectionExampleClock,
  type ReplaceProposalApplyResult,
} from '../automations/command';
import { expireDueDraftCards } from '../automations/draft-card';
import { createAutomationDelivery, type AutomationDeliveryDeps } from '../automations/delivery';
import {
  appendReplyLine,
  extractAutomationProposal,
  proposalTextFromState,
  shouldHonorAutomationProposal,
  stripProposalFromState,
  type AutomationProposalFields,
} from '../automations/proposal';
import {
  createAutomationScheduler,
  type AutomationScheduler,
} from '../automations/scheduler';
import type { AutomationItem, AutomationsStore } from '../automations/store';
import { deploymentPluginCatalog, type PluginCatalog } from '../plugins/catalog';
import type { ToolRunContext } from '../bridge-tools/server';
import { ChatModeCache, type ChatMode } from './chat-mode-cache';
import { createIdleWatchdog } from './idle-watchdog';
import { isAutomationRunScope, isAutomationScope, parseAutomationRunScope } from './scope';
import { handleCommentMention } from './comments';
import { recordRunSessionEvent, resolveRunResumeHandle, startRunFlow } from './run-flow';
import { commandSessionCatalogIdentity } from './session-catalog-identity';
import { PendingQueue } from './pending-queue';
import { ProcessPool } from './process-pool';
import { fetchQuotedContext, fetchTopicContext, type QuotedContext } from './quote';
import { lookupMessageThreadId } from './thread-id';
import { addWorkingReaction, removeReaction } from './reaction';
import { fetchKnownChats } from './lark-info';
import type { AppPaths } from '../config/app-paths';
import {
  consumeCotEvents,
  CotClient,
  CotPublisher,
  appendOutcomeNotice,
  finalAnswerOnlyState,
  finalReplyFor,
} from './cot';

const DEBOUNCE_MS = 600;
const STREAM_TERMINAL_GRACE_MS = 3000;
const REACTION_CLEANUP_GRACE_MS = 1000;
/** Retry delay while a live sweep pass is still draining staged items. */
const OUTBOX_SWEEP_MS = 50;
/** When a pass delivers nothing, wait for a new trigger instead of spinning. */
const OUTBOX_IDLE_MS = 60_000;

/** Single handshake attempt. Also the force-reconnect budget via connectTimeoutMs. */
export const CHANNEL_HANDSHAKE_TIMEOUT_MS = 8_000;
/** `connect()` / force-reconnect wait. Channel 0.6.1+ no longer reads handshakeTimeoutMs for this. */
export const CHANNEL_CONNECT_TIMEOUT_MS = CHANNEL_HANDSHAKE_TIMEOUT_MS;

/**
 * Seconds to wait for any inbound frame after a client ping before the SDK
 * terminates the socket.
 *
 * Armed when the client sends a ping, cleared on any inbound frame, and
 * reset by the next ping. The wait must stay strictly under the server
 * PingInterval or a silent socket is never torn down. The documented default
 * is {@link WS_SERVER_PING_INTERVAL_SEC}; field reports also describe 30s.
 * 15s is under both.
 *
 * 3s sat inside routine jitter and tore a healthy link down. 15s still covers
 * a lost ping through TCP retransmission (about 1s, then 3s, then 7s) and a
 * short stall. Node runs an expired timer before I/O, so a stall longer than
 * this wait drops a pong that already arrived.
 *
 * At the documented 120s cadence a silent link is torn down within
 * {@link WS_DEFAULT_DEAD_LINK_DETECT_BOUND_SEC}. A longer server interval
 * detects later. An interval of 15s or less never trips this watchdog.
 */
export const WS_PING_TIMEOUT_SEC = 15;
/**
 * Documented Feishu ClientConfig PingInterval and the SDK pre-handshake
 * default, in seconds. The server may push another value. This client does
 * not set it.
 */
export const WS_SERVER_PING_INTERVAL_SEC = 120;
/**
 * Worst case, at {@link WS_SERVER_PING_INTERVAL_SEC}, from the last inbound
 * frame until the socket is torn down. A different server cadence changes it.
 */
export const WS_DEFAULT_DEAD_LINK_DETECT_BOUND_SEC = WS_SERVER_PING_INTERVAL_SEC + WS_PING_TIMEOUT_SEC;

const BRIDGE_AGENT_INSTRUCTIONS = [
  '你在 bridge 进程中运行，普通 lark-cli 会继承 LARK_CHANNEL=1 并进入 bridge-bound 模式。',
  '不要 unset LARK_CHANNEL / LARK_CHANNEL_HOME / LARK_CHANNEL_PROFILE / LARKSUITE_CLI_CONFIG_DIR，也不要用 env -u LARK_CHANNEL 绕回本机普通配置。',
  'Codex bridge 默认使用 danger-full-access 对齐 Claude bridge 的 bypassPermissions 行为，因此 lark-cli 应能像用户本机终端一样访问 keychain。',
  '如果提示 lark-channel context detected but not bound，停止当前操作并请用户重启 bridge 或运行 bridge doctor/preflight；不要改用普通 profile，不要自行 bind，也不要直接读取 config.json 里的账号或密钥。',
];

// Lark SDK logs API errors at error level even when the caller catches them.
// These specific codes are EXPECTED in our flow (wiki-node lookup that
// usually misses, fileComment.get that we deliberately let fall back to
// .list) and the surrounding noise is already covered by our own logs.
const SUPPRESSED_API_ERROR_CODES = new Set([
  131005, // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307, // drive.fileComment.get "not exist" — fall back to .list
  1069302, // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);

const SUPPRESSED_ENDPOINT_API_ERRORS = [
  {
    code: 99991672,
    urlPart: '/open-apis/wiki/v2/spaces/get_node',
  },
];

function codeFromObj(m: unknown): number | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const top = (m as { code?: unknown }).code;
  if (typeof top === 'number') return top;
  const nested = (m as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof nested === 'number' ? nested : undefined;
}

function urlFromObj(m: unknown): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const configUrl = (m as { config?: { url?: unknown } })?.config?.url;
  if (typeof configUrl === 'string') return configUrl;
  const requestPath = (m as { request?: { path?: unknown } })?.request?.path;
  return typeof requestPath === 'string' ? requestPath : undefined;
}

function isSuppressedSdkMessage(msg: unknown): boolean {
  if (Array.isArray(msg)) return msg.some(isSuppressedSdkMessage);
  const code = codeFromObj(msg);
  if (code === undefined) return false;
  if (SUPPRESSED_API_ERROR_CODES.has(code)) return true;
  const url = urlFromObj(msg);
  return SUPPRESSED_ENDPOINT_API_ERRORS.some(
    (rule) => code === rule.code && url?.includes(rule.urlPart),
  );
}

export function shouldSuppressSdkErrorLog(args: unknown[]): boolean {
  return args.some(isSuppressedSdkMessage);
}

function buildQuietLogger(): {
  error: (...m: unknown[]) => void;
  warn: (...m: unknown[]) => void;
  info: (...m: unknown[]) => void;
  debug: (...m: unknown[]) => void;
  trace: (...m: unknown[]) => void;
} {
  return {
    error: (...args: unknown[]) => {
      if (shouldSuppressSdkErrorLog(args)) return;
      log.warn('sdk', 'error', { args: stringifyArgs(args) });
    },
    warn: (...args: unknown[]) => log.warn('sdk', 'warn', { args: stringifyArgs(args) }),
    info: (...args: unknown[]) => log.info('sdk', 'info', { args: stringifyArgs(args) }),
    debug: () => {},
    trace: () => {},
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export interface BridgeChannel {
  channel: LarkChannel;
  disconnect(opts?: { stopReason?: StopRequest }): Promise<void>;
  recover(outage?: Outage): Promise<void>;
  recoverMissed(outage?: Outage): Promise<void>;
  tickLink(): Promise<void>;
  /** Frame on the socket opened by the current wake reconnect. */
  noteLinkFrame(at?: number): void;
  /** Local wake entry (A5 owns transport). Already-started fire keys stay silent. */
  wakeAutomation(fireKey: string): Promise<void>;
}

/** Drain `onChanged`'s setImmediate board refresh, then wait until it is idle. */
async function awaitDeferredBoard(board: AutomationBoard | undefined): Promise<void> {
  if (!board) return;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await board.idle();
}

export interface StartChannelDeps {
  cfg: AppConfig;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  ledger?: BackfillLedger;
  journal?: TurnJournal;
  automations?: AutomationsStore;
  onAutomationConfirmed?: (item: AutomationItem) => void | Promise<void>;
  controls: Controls;
  appPaths?: Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile' | 'mediaDir'>
    & Partial<Pick<AppPaths, 'logsDir' | 'automationsWakeDir' | 'rootDir'>>;
  now?: () => number;
  probe?: (signal?: AbortSignal) => Promise<boolean>;
  /** Tests with a fake clock stub this so a watermark jump is not OS sleep. */
  sleepProbe?: HostSleepProbe;
  onRecovered?: (outage: Outage) => void;
  /** Per-request REST/outbound deadline. Tests shorten it; production uses the default. */
  outboundTimeoutMs?: number;
}

export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { cfg, agent, sessions, sessionCatalog, workspaces, ledger, journal, controls } = deps;
  const pluginCatalog = await deploymentPluginCatalog(deps.appPaths?.rootDir ?? dirname(controls.configPath));
  const outboundTimeoutMs = deps.outboundTimeoutMs ?? OUTBOUND_REQUEST_TIMEOUT_MS;
  let channelForCards: LarkChannel | undefined;
  const continuations = createContinuations({
    journal,
    updateCard: (id, card) => {
      if (!channelForCards) return Promise.resolve();
      return channelForCards.updateCard(id, card);
    },
  });
  const outboxSweep = {
    schedule(_delayMs?: number) {},
    stop() {},
  };
  const activeRuns = new ActiveRuns({
    onSupersede: (scope) => {
      continuations.voidScope(scope);
    },
  });
  const resumeCandidates = new ResumeCandidates();
  // ChatModeCache stays per-bridge-instance — invalidated on restart along
  // with everything else. Topic-mode chats only need one chat.get() call ever.
  const chatModeCache = new ChatModeCache();
  // Concurrency cap — reads `preferences.maxConcurrentRuns` on each acquire,
  // so /config bumps take effect for the next run.
  const pool = new ProcessPool(() => getMaxConcurrentRuns(controls.cfg));
  const executor = new RunExecutor({
    agent,
    pool,
    activeRuns,
    stderrSignatures: () => streamReliability(controls.profileConfig).signatures,
    ...(deps.now ? { now: deps.now } : {}),
    onSpawn: (input) => {
      journal?.noteSpawn({
        scope: input.scopeId,
        runId: input.runId,
        pid: input.pid,
        startedAt: input.startedAt,
      });
    },
  });

  // Resolve the App Secret to plaintext. The config field can be a literal
  // string, a "${VAR}" template, or a {source, id} SecretRef referencing
  // the encrypted keystore / env / file / exec provider. Re-resolved on
  // every startChannel so /account change picks up new secrets.
  const appSecret = await resolveAppSecret(cfg, deps.appPaths);
  const callbackNonceStore = deps.appPaths?.mediaDir
    ? new CallbackNonceStore(join(dirname(deps.appPaths.mediaDir), 'callback-nonces.json'))
    : undefined;
  await callbackNonceStore?.load();
  const callbackAuth = callbackNonceStore
    ? new CallbackAuth({
        keys: [{ version: 1, secret: appSecret }],
        nonceStore: callbackNonceStore,
      })
    : undefined;
  const noticeAuth = callbackNonceStore
    ? new NoticeActionAuth({ secret: appSecret, nonceStore: callbackNonceStore })
    : undefined;
  const autoAuth = callbackNonceStore
    ? new AutoActionAuth({
        secret: appSecret,
        nonceStore: callbackNonceStore,
        ...(deps.now ? { now: deps.now } : {}),
      })
    : undefined;
  const automationsCtl: {
    scheduler?: AutomationScheduler;
    board?: AutomationBoard;
    boardAuth?: BoardActionAuth;
  } = {};
  const removeFromChat = (chatId: string): Promise<unknown> => (
    automationsCtl.scheduler?.removeFromChat(chatId) ?? Promise.resolve()
  );
  let detachAutomationChatLifecycle = (): void => {};
  const onAutomationConfirmed = async (item: AutomationItem): Promise<void> => {
    await deps.onAutomationConfirmed?.(item);
    await automationsCtl.scheduler?.notifyChanged();
    await automationsCtl.scheduler?.nudge();
  };
  const activePolicyFingerprints = new Map<string, string>();
  // Per-scope record of the model used on the last run, so a `/config` model
  // switch can inject a one-time "model changed" note into the next (resumed)
  // prompt. In-memory only: on restart the first run re-seeds silently.
  const lastRunModelByScope = new Map<string, string>();
  const cotClient = new CotClient({
    tenant: cfg.accounts.app.tenant,
    appId: cfg.accounts.app.id,
    appSecret,
  });
  const threadModeOverrideWarnedChats = new Set<string>();
  const logThreadModeOverride: LogThreadModeOverride = ({ chatId, resolvedMode, threadId }) => {
    const fields = { chatId, cachedMode: resolvedMode, threadId };
    if (threadModeOverrideWarnedChats.has(chatId)) {
      log.info('chat', 'mode-overridden-by-thread', fields);
      return;
    }
    threadModeOverrideWarnedChats.add(chatId);
    log.warn('chat', 'mode-overridden-by-thread', fields);
  };

  let feishuLink: ReturnType<typeof startFeishuLink> | undefined;
  const opts: LarkChannelOptions = {
    appId: cfg.accounts.app.id,
    appSecret,
    domain:
      cfg.accounts.app.tenant === 'lark'
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn',
    source: 'lark-channel-bridge',
    logger: buildQuietLogger(),
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
      botLoopGuard: { enabled: true },
    },
    // Disable per-chat serialization so we can implement our own
    // debounce + run-chain policy (see pending-queue + runChain below).
    safety: {
      chatQueue: { enabled: false },
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    outbound: {
      streamThrottleMs: 400,
    },
    // SDK 1.65.0-alpha.3+ knobs. See WS_PING_TIMEOUT_SEC.
    wsConfig: {
      pingTimeout: WS_PING_TIMEOUT_SEC,
    },
    // Transport-only reconnect: the SDK watchdog force-reconnects a stuck
    // WebSocket. The bridge never calls controls.restart for link problems.
    // A suspend gap uses the same socket reconnect and waits for a new frame.
    keepalive: {
      enabled: true,
      onUnrecoverable: (err) => {
        log.fail('ws', err, { kind: 'unrecoverable' });
      },
      onWake: () => {
        feishuLink?.noteKeepaliveWake();
      },
      onSocketFrame: () => {
        feishuLink?.noteSocketFrame();
      },
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks. Channel 0.6.1+ uses
    // connectTimeoutMs for force-reconnect; keep both on the same budget.
    handshakeTimeoutMs: CHANNEL_HANDSHAKE_TIMEOUT_MS,
    connectTimeoutMs: CHANNEL_CONNECT_TIMEOUT_MS,
    // Per-request REST timeout — without a cap a slow API can hang the
    // event-handling thread.
    httpTimeoutMs: 30_000,
    // Route WS + REST through HTTPS_PROXY / HTTP_PROXY when set (no-op otherwise).
    respectProxyEnv: true,
  };

  const channel = createLarkChannel(opts);
  channelForCards = channel;
  const outboundIds = new OutboundMessageIds();
  const cliSelfSent = new CliSelfSendTracker();
  const media = new MediaCache(channel, deps.appPaths?.mediaDir);

  // Pending → run handoff: while a run is active on a chat, block its pending
  // queue so messages keep accumulating without flushing. When the run ends,
  // unblock arms a fresh quiet-window timer. Net effect: at most one run per
  // chat in flight, and everything sent during a run merges into the next
  // batch (only flushed once 600ms of silence has passed *after* the run).
  let closing = false;
  const backfillMarks = new Map<string, BackfillMark>();
  const runScheduledBackfill = createBackfillRun();
  const runConsumers = new Set<Promise<unknown>>();
  const trackConsumer = <T>(work: Promise<T>, phase: string): Promise<T> => {
    if (runConsumers.has(work)) return work;
    runConsumers.add(work);
    void work.then(
      () => { runConsumers.delete(work); },
      error => { runConsumers.delete(work); log.fail(phase, error); },
    );
    return work;
  };
  const pending = new PendingQueue(DEBOUNCE_MS, (scope, batch) => {
    if (closing) {
      if (ledger) {
        unrecordAcceptedMessages(ledger, batch);
        log.info('pending', 'handoff', {
          count: batch.length,
          reason: 'closing-flush',
          incompleteFrom: ledger.getIncompleteFrom(),
        });
      }
      return;
    }
    const firstMsg = batch[0];
    if (!firstMsg) return;
    pending.block(scope);
    void trackConsumer(withTrace({ chatId: firstMsg.chatId }, async () => {
      const sessionWriter = activeRuns.trackSessionWriter(scope);
      log.info('flush', 'start', {
        scope,
        batchSize: batch.length,
        chatId: firstMsg.chatId,
        threadId: firstMsg.threadId,
        msgId: firstMsg.messageId,
      });
      try {
        const resolvedMode = await chatModeCache.resolve(channel, firstMsg.chatId);
        // Feishu/Lark converted topic groups may still resolve as `group` from
        // the chat info API/cache, while message events already carry threadId.
        // Treat threadId as authoritative for IM messages so scope and replies
        // stay isolated per topic.
        const mode = firstMsg.threadId ? 'topic' : resolvedMode;
        if (firstMsg.threadId && resolvedMode !== 'topic') {
          chatModeCache.invalidate(firstMsg.chatId);
          logThreadModeOverride({
            chatId: firstMsg.chatId,
            resolvedMode,
            threadId: firstMsg.threadId,
          });
        }
        await runAgentBatch({
          channel,
          executor,
          sessions,
          sessionCatalog,
          workspaces,
          media,
          batch,
          controls,
          cotClient,
          callbackAuth,
          noticeAuth,
          activePolicyFingerprints,
          lastRunModelByScope,
          canRecordSession: sessionWriter.isCurrent,
          scope,
          mode,
          backfillMarks,
          ledger,
          journal,
          continuations,
          cliSelfSent,
          link,
          onDeliveryWait: (delayMs) => outboxSweep.schedule(delayMs),
          outboundTimeoutMs,
          automations: deps.automations,
          pluginCatalog,
          autoAuth,
          automationsScheduler: automationsCtl.scheduler,
          ...(deps.now ? { now: deps.now } : {}),
        });
      } finally {
        sessionWriter.release();
        pending.unblock(scope);
        log.info('flush', 'end');
      }
    }), 'flush');
  });

  // Counter for stdout reconnect escalation; reset on `reconnected`.
  let consecutiveReconnects = 0;

  const handOffIntake = (msg: NormalizedMessage, source: IntakeSource): Promise<void> =>
    withTrace({ chatId: msg.chatId, msgId: msg.messageId }, () =>
      intakeMessage({
        channel,
        agent,
        sessions,
        sessionCatalog,
        resumeCandidates,
        workspaces,
        ledger,
        intakeSource: source,
        activeRuns,
        pending,
        msg,
        controls,
        chatModeCache,
        logThreadModeOverride,
        executor,
        pool,
        automations: deps.automations,
        autoAuth,
        automationsScheduler: automationsCtl.scheduler,
        journal,
        ...(deps.now ? { now: deps.now } : {}),
        isLinkDown: () => closing || started.isDown(),
        onAutomationConfirmed,
      }),
    ).catch((err) => {
      log.fail('intake', err);
    });

  const launchBackfill = (fromMs: number, since?: number): Promise<boolean> => {
    if (!ledger) return Promise.resolve(true);
    return trackConsumer(runScheduledBackfill({
      fromMs,
      ...(since !== undefined ? { since } : {}),
      channel: channel as unknown as BackfillChannel,
      ledger,
      prefs: getBackfillPreferences(controls.cfg),
      botAppId: controls.cfg.accounts.app.id,
      profile: controls.profileConfig,
      ...(deps.now ? { now: deps.now } : {}),
      marks: backfillMarks,
      isClosing: () => closing,
      refreshKnownChats: (chats) => {
        controls.knownChats = chats;
      },
      sessionChatIds: [
        ...sessions.scopeIds(),
        ...(sessionCatalog?.entries().map((entry) => entry.scopeId) ?? []),
      ],
      intake: (msg) => handOffIntake(msg, 'backfill'),
      requireMentionForChat: (chatId) => (
        requireMentionForChat(controls.profileConfig, controls.cfg, chatId)
      ),
    }), 'backfill');
  };

  const journalRecoverOpts = (owned: TurnJournal) => ({
    isDown: () => closing || link.isDown(),
    resend: (entry: TurnJournalEntry) => resendJournalReply({
      channel,
      journal: owned,
      entry,
      botAppId: cfg.accounts.app.id,
      now: deps.now,
      onNotInChat: removeFromChat,
    }),
    resendNotice: (entry: TurnJournalEntry) => resendPendingNotice({
      send: (chatId: string, content: { markdown: string } | { card: object }, options?: {
        replyTo?: string;
        replyInThread?: boolean;
        uuid?: string;
      }) => channel.send(chatId, content, options),
      entry,
      journal: owned,
      noticeAuth,
    }),
    onInterrupted: async (entry: TurnJournalEntry) => {
      const outcome = entry.outcome ?? {
        kind: 'interrupted' as const,
        reason: { type: 'external-signal' as const },
        retriable: true,
        needsHuman: false,
      };
      if (isAutomationScope(entry.scope)) {
        if (entry.cliAlreadySent || replyState(entry) === 'sent') return true;
        if (isAutomationRunScope(entry.scope) && !owned.get(entry.turnId)?.reply) {
          const parsed = parseAutomationRunScope(entry.scope);
          const item = parsed ? deps.automations?.get(parsed.id) : undefined;
          const timezone = item?.timezone;
          const fireAt = parsed?.fireAt;
          owned.stageReply(entry.turnId, {
            markdown: formatAgentFailureNotice(outcome, {
              now: (deps.now ?? Date.now)(),
              catchUp: typeof entry.userInput === 'string'
                && entry.userInput.includes(CATCH_UP_PROMPT_MARKER),
              ...(typeof timezone === 'string' && timezone.length > 0 ? { timezone } : {}),
              ...(typeof fireAt === 'number' ? { fireAt } : {}),
            }),
            replyTo: '',
            replyMode: 'text',
            deliveryId: replyDeliveryKey(entry.turnId),
          });
          await owned.flush();
          log.info('auto', 'result', {
            turnId: entry.turnId,
            scope: entry.scope,
            outcome: formatRunOutcome(outcome),
          });
        }
        const latest = owned.get(entry.turnId) ?? entry;
        if (!latest.reply) return true;
        if (link.isDown()) return false;
        const delivered = await resendJournalReply({
          channel,
          journal: owned,
          entry: latest,
          botAppId: cfg.accounts.app.id,
          now: deps.now,
          onNotInChat: removeFromChat,
        });
        if (delivered) {
          owned.replyDelivered(entry.turnId);
          await owned.flush();
        }
        return delivered;
      }
      if (planInterruptionNotice(outcome).kind === 'continue') {
        continuations.offer(entry.turnId, outcome);
      }
      if (link.isDown()) {
        stageInterruptionNotice({
          journal: owned,
          turnId: entry.turnId,
          outcome,
          noticeAuth,
          consecutive: continuations.consecutive(entry.scope),
          requireBotMention: requireMentionForChat(
            controls.profileConfig,
            controls.cfg,
            entry.chatId,
          ),
          ownerId: controls.botOwnerId,
          authNotified: authNoticeAlreadyDelivered(owned),
        });
        return false;
      }
      const result = await deliverInterruptionNotice({
        send: (chatId, content, options) => channel.send(chatId, content, options),
        journal: owned,
        turnId: entry.turnId,
        outcome,
        noticeAuth,
        consecutive: continuations.consecutive(entry.scope),
        requireBotMention: requireMentionForChat(
          controls.profileConfig,
          controls.cfg,
          entry.chatId,
        ),
        ownerId: controls.botOwnerId,
        authNotified: authNoticeAlreadyDelivered(owned),
      });
      return result.delivered;
    },
    noticeGapMs: NOTICE_RESTART_GAP_MS,
    isActive: (scope: string) => activeRuns.get(scope) !== undefined,
  });

  let sweepTimer: ReturnType<typeof setTimeout> | undefined;
  let sweepStopped = false;
  let sweepDelayMs = OUTBOX_SWEEP_MS;
  let sweepInFlight = false;
  let sweepQueued = false;
  let sweepTail: Promise<void> = Promise.resolve();
  const armSweepTimer = (delayMs: number): void => {
    if (sweepTimer) clearTimeout(sweepTimer);
    sweepTimer = setTimeout(() => {
      sweepTimer = undefined;
      void runOutboxSweep();
    }, delayMs);
  };
  const runOutboxSweep = (): Promise<void> => {
    if (sweepStopped || !journal || link.isDown()) return Promise.resolve();
    if (sweepInFlight) {
      sweepQueued = true;
      return sweepTail;
    }
    sweepInFlight = true;
    const stagedBefore = stagedOutboxCount(journal);
    sweepTail = trackConsumer(journal.redeliver(journalRecoverOpts(journal)), 'journal').then(() => {
      if (sweepStopped || link.isDown()) return;
      const stagedAfter = stagedOutboxCount(journal);
      if (stagedAfter === 0) {
        sweepDelayMs = OUTBOX_SWEEP_MS;
        return;
      }
      armSweepTimer(stagedAfter === stagedBefore ? OUTBOX_IDLE_MS : OUTBOX_SWEEP_MS);
    }, (error: unknown) => {
      if (sweepStopped) return;
      const delay = rateLimitResetDelayMs(error) ?? sweepDelayMs;
      sweepDelayMs = Math.min(sweepDelayMs * 2, RECOVERY_RETRY_MAX_MS);
      armSweepTimer(delay);
    }).finally(() => {
      sweepInFlight = false;
      if (!sweepQueued) return;
      sweepQueued = false;
      return runOutboxSweep();
    });
    return sweepTail;
  };
  outboxSweep.schedule = (delayMs = 0) => {
    sweepDelayMs = OUTBOX_SWEEP_MS;
    if (delayMs > 0) {
      armSweepTimer(delayMs);
      return;
    }
    void runOutboxSweep();
  };
  outboxSweep.stop = () => {
    sweepStopped = true;
    if (sweepTimer) clearTimeout(sweepTimer);
    sweepTimer = undefined;
  };

  const recovery = createRecovery({
    journal: {
      reapOrphans: () => {
        if (!journal) return Promise.resolve();
        return trackConsumer(journal.reapOrphans(journalRecoverOpts(journal)), 'journal');
      },
      redeliver: () => {
        if (!journal) return Promise.resolve();
        return trackConsumer(journal.redeliver(journalRecoverOpts(journal)), 'journal');
      },
    },
    backfill: {
      scan: (fromMs) => launchBackfill(fromMs),
    },
    runs: {
      review: (outage) => reviewActiveRuns(activeRuns.snapshot(), outage),
    },
    lookbackMs: () => getBackfillPreferences(controls.cfg).lookbackMs,
    ...(deps.now ? { now: deps.now } : {}),
    incompleteFrom: () => ledger?.getIncompleteFrom(),
    preserveOutage: async (since) => {
      if (!ledger) return;
      ledger.markScanIncomplete(since);
      await ledger.flush();
    },
  });

  const recover = async (outage?: Outage): Promise<void> => {
    const now = (deps.now ?? Date.now)();
    await recovery.run({
      since: outage?.since ?? ledger?.getLiveAt() ?? now,
      until: outage?.until ?? now,
      hostSuspended: outage?.hostSuspended === true,
      ...(outage?.suspendStartedAt !== undefined ? { suspendStartedAt: outage.suspendStartedAt } : {}),
    });
    sweepDelayMs = OUTBOX_SWEEP_MS;
    await runOutboxSweep();
  };

  const started = startFeishuLink({
    channel,
    reconnect: () => {
      if (typeof channel.forceReconnect !== 'function') return;
      return channel.forceReconnect();
    },
    probe: deps.probe ?? createFeishuProbe(channel),
    watermark: {
      get: () => ledger?.getLiveAt(),
      holdOutage: (since) => {
        ledger?.markScanIncomplete(since);
      },
      set: (at) => {
        ledger?.touchLive(at);
      },
    },
    outbound: outboundIds,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.outboundTimeoutMs !== undefined ? { outboundTimeoutMs: deps.outboundTimeoutMs } : {}),
    ...(deps.sleepProbe ? { sleepProbe: deps.sleepProbe } : {}),
    heartbeatPath: deps.appPaths?.logsDir ? join(deps.appPaths.logsDir, 'heartbeat') : undefined,
  });
  if (deps.automations) {
    const automations = deps.automations;
    if (controls.profileConfig.automations.enabled) {
      automationsCtl.boardAuth = new BoardActionAuth({
        secret: appSecret,
        ...(deps.now ? { now: deps.now } : {}),
      });
      automationsCtl.board = createAutomationBoard({
        store: deps.automations,
        channel,
        auth: automationsCtl.boardAuth,
        lockPath: join(dirname(deps.automations.getFilePath()), 'automations-board.lock'),
        onNotInChat: removeFromChat,
        ...(deps.now ? { now: deps.now } : {}),
      });
    }
    const automationOutbox: AutomationDeliveryDeps = {
      journal,
      channel,
      botAppId: cfg.accounts.app.id,
      botOpenId: () => channel.botIdentity?.openId ?? '',
      isLinkDown: () => closing || started.isDown(),
      ...(deps.now ? { now: deps.now } : {}),
      ...(journal ? {
        deliver: (entry) => resendJournalReply({
          channel,
          journal,
          entry,
          botAppId: cfg.accounts.app.id,
          now: deps.now,
          onNotInChat: removeFromChat,
        }),
      } : {}),
      onUndelivered: () => outboxSweep.schedule(),
      onNotInChat: removeFromChat,
    };
    automationsCtl.scheduler = createAutomationScheduler({
      store: deps.automations,
      ...createAutomationDelivery({
        ...automationOutbox,
        runAgentFire: (fire) => trackConsumer(runAutomationAgentFire(fire, {
          ...automationOutbox,
          executor,
          sessions,
          ...(sessionCatalog ? { sessionCatalog } : {}),
          workspaces,
          profile: controls.profile,
          profileConfig: controls.profileConfig,
          cfg: controls.cfg,
          ...(controls.botOwnerId ? { botOwnerId: controls.botOwnerId } : {}),
          ownerRefreshState: controls.ownerRefreshState,
          automations,
          pauseItem: (id) => automationsCtl.scheduler?.pause(id) ?? automations.pause(id),
          botDisplayName: () => channel.botIdentity?.name ?? 'bot',
          onFireSettled: () => automationsCtl.board?.refresh() ?? Promise.resolve(),
        }), 'auto'),
      }),
      botDisplayName: () => channel.botIdentity?.name ?? 'bot',
      ...(deps.now ? { now: deps.now } : {}),
      isLinkUp: () => !closing && !started.isDown(),
      enabled: () => controls.profileConfig.automations.enabled,
      agentTasks: () => controls.profileConfig.automations.agentTasks,
      onChanged: () => {
        const board = automationsCtl.board;
        if (!board) return Promise.resolve();
        setImmediate(() => {
          void board.refresh();
        });
        return Promise.resolve();
      },
      onExpireDrafts: () => expireDueDraftCards({ store: automations, channel }),
      wakeDir: deps.appPaths?.automationsWakeDir
        ?? join(dirname(deps.automations.getFilePath()), 'automations-wake'),
      statusPush: {
        profile: controls.profile,
        ...(controls.profileConfig.automations.statusEndpoint
          ? { endpoint: controls.profileConfig.automations.statusEndpoint }
          : {}),
        ...(controls.profileConfig.automations.statusSecret
          ? { secret: controls.profileConfig.automations.statusSecret }
          : {}),
      },
    });
    detachAutomationChatLifecycle = attachAutomationChatLifecycle(channel, removeFromChat);
  }
  const automationsScheduler = automationsCtl.scheduler;
  started.onRecovered((outage) => {
    deps.onRecovered?.(outage);
    void trackConsumer(recover(outage), 'recovery');
    if (automationsScheduler || automationsCtl.board) {
      void trackConsumer((async () => {
        await automationsScheduler?.onLinkRecovered();
        if (deps.automations && autoAuth) {
          await flushPendingDraftCards({
            channel,
            automations: deps.automations,
            botAppId: controls.profileConfig.accounts.app.id,
            autoAuth,
            automationsScheduler,
            ...(deps.now ? { now: deps.now } : {}),
            isLinkDown: () => closing || started.isDown(),
          });
        }
        await automationsCtl.board?.refresh();
      })(), 'auto');
    }
  });
  started.onSuspendAmended((outage) => {
    reviewActiveRuns(activeRuns.snapshot(), outage);
  });
  feishuLink = started;
  const link = started;

  channel.on({
    message: async (msg) => {
      link.noteInbound();
      if (dropInboundSelfMessage({
        msg,
        botOpenId: channel.botIdentity?.openId,
        botAppId: controls.cfg.accounts.app.id,
        outbound: outboundIds,
        tracker: cliSelfSent,
        journal,
      })) {
        return;
      }
      if (closing) {
        markClosingArrival(ledger, msg);
        return;
      }
      await handOffIntake(msg, 'ws');
    },
    reject: (evt) => {
      log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      if (closing) return;
      return withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
        return handleCardAction({
          channel,
          evt,
          sessions,
          resumeCandidates,
          sessionCatalog,
          workspaces,
          ledger,
          activeRuns,
          agent,
          processPool: pool,
          runExecutor: executor,
          controls,
          pending,
          chatModeCache,
          callbackAuth,
          callbackPolicyFingerprintForScope: (scope) => activePolicyFingerprints.get(scope),
          journal,
          noticeAuth,
          autoAuth,
          boardAuth: automationsCtl.boardAuth,
          automations: deps.automations,
          automationsScheduler: automationsCtl.scheduler,
          ...(deps.now ? { now: deps.now } : {}),
          onAutomationConfirmed,
          continuations,
          onNoticeAction: async ({ action, entry, operatorId, scope, threadId, mode, messageId }) => {
            if (action !== 'notice.continue') return;
            pending.push(scope, {
              messageId: messageId || entry.messageIds.at(-1) || `notice-continue-${entry.turnId}`,
              chatId: entry.chatId,
              chatType: mode === 'p2p' ? 'p2p' : 'group',
              threadId,
              senderId: operatorId,
              senderName: '',
              content: entry.resumeHandle ? '继续' : (entry.userInput ?? '继续'),
              rawContentType: 'text',
              resources: journalResourcesToMessage(entry.resources),
              mentions: [],
              mentionAll: false,
              mentionedBot: true,
              createTime: Date.now(),
            });
          },
        });
      }).catch((err) => log.fail('cardAction', err));
    },
    comment: async (evt) => {
      if (closing) return;
      await trackConsumer(withTrace({ chatId: 'comment' }, async () => {
        await handleCommentMention({
          channel,
          evt,
          agent,
          sessions,
          sessionCatalog,
          workspaces,
          activeRuns,
          executor,
          controls,
        });
      }), 'comment').catch(() => {});
    },
    reconnecting: () => {
      consecutiveReconnects++;
      log.warn('ws', 'reconnecting', { consecutive: consecutiveReconnects });
      reportMetric('ws_reconnect', 1, { kind: 'ws' });
      // Stdout escalation — surface jitter that's hidden in the file log.
      if (consecutiveReconnects === 3) {
        console.error('⚠️ 已连续重连 3 次,网络可能不稳。');
      } else if (consecutiveReconnects === 10) {
        console.error('❌ 已连续重连 10 次,建议在飞书发 /reconnect 或重启 bot。');
      }
      void link.tick();
    },
    reconnected: () => {
      if (consecutiveReconnects > 1) {
        log.info('ws', 'recovered', { afterAttempts: consecutiveReconnects });
      } else {
        log.info('ws', 'reconnected');
      }
      consecutiveReconnects = 0;
      void link.tick();
    },
    // Classify common WS errors into the `network` phase so /doctor and grep
    // can find them without scanning generic `ws.fail` entries.
    error: (err) => {
      const msg = err?.message ?? String(err);
      if (/ENOTFOUND|getaddrinfo/.test(msg)) {
        log.fail('network', err, { kind: 'dns', code: err.code });
      } else if (/handshake|did not complete/.test(msg)) {
        log.fail('network', err, { kind: 'handshake-timeout', code: err.code });
      } else if (/timeout/i.test(msg)) {
        log.fail('network', err, { kind: 'timeout', code: err.code });
      } else {
        log.fail('ws', err, { code: err.code });
      }
    },
  });

  // In-meeting agent. Created before connect() so the `vc.bot.*` handlers are
  // installed on the event dispatcher before any push can arrive; sessions are
  // only created later (on /meeting join or an invite), so the late-bound
  // botOpenId getter is resolved by then.
  const meetingConfig = () => controls.profileConfig.meeting;
  let meetingManager: MeetingManager | undefined;
  if (meetingConfig().enabled) {
    meetingManager = new MeetingManager({
      client: channel.rawClient as unknown as VcRequestClient,
      config: meetingConfig,
      botOpenId: () => channel.botIdentity?.openId,
      channel,
      authorizeInvite: (inviterId, chatId) =>
        evaluateAccess({
          entry: 'meeting',
          profile: controls.profileConfig,
          controls,
          chatId: chatId ?? '',
          senderId: inviterId ?? '',
        }).ok,
      // Meeting over: optionally summarize to IM (config-gated inside).
      onEnded: (session) =>
        void summarizeEndedMeeting({
          session,
          channel,
          controls,
          executor,
          activeRuns,
          sessions,
          ...(sessionCatalog ? { sessionCatalog } : {}),
          workspaces,
        }).catch((err) => log.warn('meeting', 'summary-failed', { err: String(err) })),
      onSession: (session) =>
        attachMeetingAgent({
          session,
          channel,
          controls,
          executor,
          activeRuns,
          sessions,
          ...(sessionCatalog ? { sessionCatalog } : {}),
          workspaces,
        }),
    });
    meetingManager.attachPush();
    controls.meeting = meetingManager;
  }

  await channel.connect();
  await started.tick();
  const ownerRefresh = createOwnerRefreshController({
    controls,
    source: channel,
    appId: cfg.accounts.app.id,
  });
  await ownerRefresh.start();
  const knownChatsRefresh = startKnownChatsRefreshTimer(channel, controls);

  const identity = channel.botIdentity;
  // Late-bind the bot's own IM identity into the agent adapter so the system
  // prompt can state "this open_id is you" with the real value. Covers both
  // initial start and credential-swap reconnects (both go through here).
  if (identity?.openId) {
    agent.setBotIdentity?.({
      openId: identity.openId,
      ...(identity.name ? { name: identity.name } : {}),
    });
  }
  log.info('ws', 'connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    agent: `${agent.displayName} (${agent.id})`,
    appId: cfg.accounts.app.id,
    procId: controls.processId,
  });
  console.log('正在监听消息。按 Ctrl+C 退出。\n');

  if (automationsScheduler) await automationsScheduler.start();
  await awaitDeferredBoard(automationsCtl.board);

  return {
    channel,
    recover,
    recoverMissed: recover,
    tickLink: () => started.tick(),
    noteLinkFrame: (at?: number) => {
      started.noteSocketFrame(at);
    },
    wakeAutomation: async (fireKey) => {
      if (!automationsScheduler) return;
      await automationsScheduler.wake(fireKey);
      await awaitDeferredBoard(automationsCtl.board);
    },
    disconnect: async (opts?: { stopReason?: StopRequest }) => {
      closing = true;
      detachAutomationChatLifecycle();
      automationsScheduler?.stop();
      await automationsScheduler?.idle();
      await awaitDeferredBoard(automationsCtl.board);
      await recovery.stop();
      outboxSweep.stop();
      resumeCandidates.clear();
      // Commands can themselves call disconnect, so track run consumers only,
      // never the enclosing message/card command handler (which would self-wait).
      const consumers = [...runConsumers];
      activeRuns.pauseNewRuns('bridge-disconnect');
      pool.cancelPending();
      ownerRefresh.stop();
      knownChatsRefresh.stop();
      started.stop();
      // A reconnect keeps meeting membership while stopping local timers.
      meetingManager?.dispose();
      controls.meeting = undefined;
      abandonUnstartedPending(pending, ledger);
      const first = await Promise.allSettled([
        channel.disconnect(),
        activeRuns.stopAll(opts?.stopReason ?? { type: 'shutdown-signal' }),
        ...consumers,
      ]);
      // Run cleanup and bot event consumption are distinct completion points.
      // Both must settle before flush observes the last queued session write.
      const saved = await Promise.allSettled([
        sessions.flush(), sessionCatalog?.flush(), callbackNonceStore?.flush(), workspaces.flush(),
        ledger?.flush(), journal?.flush(), deps.automations?.flush(),
      ]);
      const steps = ['channel', 'stopAll', ...consumers.map(() => 'run-consumer'),
        'sessions', 'catalog', 'callback-nonces', 'workspaces', 'ledger', 'journal', 'automations'];
      const failures: unknown[] = [];
      for (const [index, result] of [...first, ...saved].entries()) {
        if (result.status === 'rejected') {
          log.fail('disconnect', result.reason, { step: steps[index] });
          failures.push(result.reason);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'profile shutdown did not complete cleanly');
    },
  };
}

function startKnownChatsRefreshTimer(
  channel: LarkChannel,
  controls: Controls,
): { stop(): void } {
  const intervalMs = 30 * 60 * 1000;
  const refresh = async (): Promise<void> => {
    const chats = await fetchKnownChats(channel);
    if (chats.length > 0) {
      controls.knownChats = chats;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function sendNonAllowedGroupHint(
  channel: LarkChannel,
  chatId: string,
  replyToMessageId: string,
): Promise<void> {
  const text =
    '当前群尚未加入响应列表，所以 bot 不会处理消息。\n' +
    'Bot owner/管理员可在本群发 /invite group 加入白名单。';
  try {
    await channel.send(chatId, { text }, { replyTo: replyToMessageId });
  } catch {
    await channel.send(chatId, { text });
  }
}

/**
 * The SDK (@larksuite/channel >= 0.4.1) normalizes a merge_forward whose
 * sub-messages it could not fetch — after its own retries — to this exact
 * sentinel, rather than the empty `<forwarded_messages/>` it emits for a
 * genuinely empty forward. Distinguishing the two is the whole point of that
 * fix: pre-0.4.1 a transient Feishu 5xx/timeout on `im.v1.message.get` was
 * silently indistinguishable from empty, so the agent saw an empty forward and
 * replied "转发内容是空的，请重新转发一次".
 */
const FORWARD_FETCH_FAILED_CONTENT = '<forwarded_messages status="fetch_failed"/>';

/** True when a message is a merge_forward the SDK failed to fetch (see above). */
function isForwardFetchFailed(msg: NormalizedMessage): boolean {
  return (
    msg.rawContentType === 'merge_forward' &&
    msg.content.trim() === FORWARD_FETCH_FAILED_CONTENT
  );
}

async function sendForwardFetchFailedHint(
  channel: LarkChannel,
  chatId: string,
  replyToMessageId: string,
): Promise<void> {
  const text =
    '这条合并转发的内容没能从飞书拉取到（上游超时/网络抖动，已自动重试仍失败），' +
    '所以我没收到里面的消息。麻烦稍后重新转发一次。';
  try {
    await channel.send(chatId, { text }, { replyTo: replyToMessageId });
  } catch {
    await channel.send(chatId, { text });
  }
}

interface IntakeDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  resumeCandidates: ResumeCandidates;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  ledger?: BackfillLedger;
  intakeSource?: IntakeSource;
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  msg: NormalizedMessage;
  controls: Controls;
  chatModeCache: ChatModeCache;
  logThreadModeOverride: LogThreadModeOverride;
  executor: RunExecutor;
  pool: ProcessPool;
  automations?: AutomationsStore;
  autoAuth?: AutoActionAuth;
  automationsScheduler?: AutomationScheduler;
  journal?: TurnJournal;
  now?: () => number;
  isLinkDown?: () => boolean;
  onAutomationConfirmed?: (item: AutomationItem) => void | Promise<void>;
}

type LogThreadModeOverride = (input: {
  chatId: string;
  resolvedMode: ChatMode;
  threadId: string;
}) => void;

async function intakeMessage(deps: IntakeDeps): Promise<void> {
  const { ledger, msg } = deps;
  const source = deps.intakeSource ?? 'ws';
  const scopeHint = msg.threadId ? `${msg.chatId}:${msg.threadId}` : msg.chatId;
  if (ledger && !ledger.claim(msg.messageId)) {
    log.info('intake', 'skip-duplicate', { msgId: msg.messageId, scope: scopeHint, source });
    reportMetric('intake_duplicate_dropped', 1, { source });
    return;
  }
  try {
    await intakeAcceptedOrGated(deps);
  } catch (err) {
    ledger?.release(msg.messageId);
    if (classify(err) === 'link') {
      ledger?.markScanIncomplete(messageCreateTime(msg) ?? Date.now());
    }
    throw err;
  }
}

async function intakeAcceptedOrGated(deps: IntakeDeps): Promise<void> {
  const {
    channel,
    agent,
    sessions,
    sessionCatalog,
    resumeCandidates,
    workspaces,
    ledger,
    activeRuns,
    pending,
    msg,
    controls,
    chatModeCache,
    logThreadModeOverride,
    executor,
    pool,
    automations,
    autoAuth,
    automationsScheduler,
    journal,
    now,
    isLinkDown,
    onAutomationConfirmed,
  } = deps;
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
  // Resolve scope (and underlying chat mode) once at intake — every
  // downstream consumer keys off these.
  const resolvedMode = await chatModeCache.resolve(channel, msg.chatId);
  // Feishu delivers a sizable fraction of topic-group message events without a
  // `thread_id` (notably the message that opens a new topic). We route topic
  // replies (`replyInThread`) and isolate per-topic session scope off it, so a
  // missing one makes the reply escape into a brand-new topic AND collapses the
  // scope to the chat level. When getChatMode says this is a topic group but
  // the event dropped `thread_id`, backfill it from the raw message — the same
  // recovery the card-click path uses.
  let threadId = msg.threadId;
  if (!threadId && resolvedMode === 'topic') {
    threadId = await lookupMessageThreadId(channel, msg.messageId);
    if (threadId) {
      log.info('intake', 'thread-id-backfilled', {
        chatId: msg.chatId,
        msgId: msg.messageId,
        threadId,
      });
    }
  }
  // Carry the (possibly backfilled) threadId on the message so the batched
  // flush — which reads `firstMsg.threadId` for reply routing and topic scope —
  // sees it.
  const emsg: NormalizedMessage = threadId === msg.threadId ? msg : { ...msg, threadId };
  // Some groups are converted into topic groups after creation. In that state
  // getChatMode can lag behind the message event shape, so threadId is the
  // stronger signal for topic-scoped sessions and reply routing.
  const chatMode = threadId ? 'topic' : resolvedMode;
  if (threadId && resolvedMode !== 'topic') {
    chatModeCache.invalidate(msg.chatId);
    logThreadModeOverride({
      chatId: msg.chatId,
      resolvedMode,
      threadId,
    });
  }
  const scope = automationScopeForReply(journal, emsg)
    ?? (chatMode === 'topic' && threadId
      ? `${msg.chatId}:${threadId}`
      : msg.chatId);
  log.info('intake', 'enter', {
    scope,
    chatType: msg.chatType,
    chatMode,
    resolvedMode,
    threadId,
    msgId: msg.messageId,
    sender: msg.senderId,
    preview,
    resources: msg.resources.length,
  });

  const accessDecision =
    msg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, msg.senderId, msg.chatId)
      : canUseGroup(controls.profileConfig, controls, msg.chatId, msg.senderId);
  if (!accessDecision.ok) {
    log.info('intake', 'skip-not-allowed-user', {
      scope,
      sender: msg.senderId.slice(-6),
      reason: accessDecision.reason,
    });
    if (msg.chatType !== 'p2p' && accessDecision.reason === 'denied-chat' && msg.mentionedBot) {
      void sendNonAllowedGroupHint(channel, msg.chatId, msg.messageId).catch((err) =>
        log.warn('intake', 'non-allowed-hint-failed', { err: String(err) }),
      );
    }
    ledger?.release(msg.messageId);
    return;
  }

  // Group-mention policy. p2p is always unrestricted; in groups (regular and
  // topic) we drop messages that don't @bot when the user has opted into the
  // quiet-by-default behavior. A per-chat override (set from /config's group
  // picker) takes priority over the global setting, so one group can respond
  // to everything while others stay @-only (or vice versa). Slash commands are
  // NOT exempt — the user chose strict mode so the group stays uniformly quiet
  // unless mentioned. @全员 is already filtered by SDK
  // (`respondToMentionAll: false`), so any event reaching here is either
  // targeted or undirected chatter.
  if (
    msg.chatType !== 'p2p' &&
    requireMentionForChat(controls.profileConfig, controls.cfg, msg.chatId) &&
    !msg.mentionedBot
  ) {
    log.info('intake', 'skip-no-mention', { scope, chatType: msg.chatType });
    ledger?.release(msg.messageId);
    return;
  }

  // A merge_forward whose sub-messages the SDK could not fetch (transient
  // upstream failure, already retried inside @larksuite/channel) arrives as the
  // fetch_failed sentinel. Feeding it to the agent would read as an empty
  // forward, so surface a recoverable hint and skip the run — the user can
  // resend once the upstream recovers.
  if (isForwardFetchFailed(emsg)) {
    log.warn('intake', 'forward-fetch-failed', {
      scope,
      msgId: emsg.messageId,
      chatType: emsg.chatType,
    });
    await sendForwardFetchFailedHint(channel, emsg.chatId, emsg.messageId).catch((err) =>
      log.warn('intake', 'forward-fetch-failed-hint-failed', { err: String(err) }),
    );
    ledger?.release(msg.messageId);
    return;
  }

  const handled = await tryHandleCommand({
    channel,
    msg: emsg,
    scope,
    chatMode,
    sessions,
    resumeCandidates,
    workspaces,
    ledger,
    agent,
    activeRuns,
    sessionCatalog,
    sessionCatalogIdentity: await commandSessionCatalogIdentity({
      msg: emsg,
      scope,
      mode: chatMode,
      workspaces,
      controls,
      access: accessDecision,
    }),
    runExecutor: executor,
    processPool: pool,
    pending,
    controls,
    automations,
    autoAuth,
    automationsScheduler,
    ...(now ? { now } : {}),
    ...(isLinkDown ? { isLinkDown } : {}),
    onAutomationConfirmed,
  });
  if (handled) {
    if (commandClearsPending(emsg.content)) {
      const dropped = pending.cancel(scope);
      log.info('intake', 'command', { scope, droppedPending: dropped.length });
      if (dropped.length > 0) {
        try {
          await channel.send(
            emsg.chatId,
            { markdown: `已取消 ${dropped.length} 条尚未开始的排队消息。` },
            { replyTo: emsg.messageId },
          );
        } catch (err) {
          if (ledger) unrecordAcceptedMessages(ledger, dropped);
          log.warn('intake', 'pending-cancel-confirm-failed', { err: String(err) });
        }
      }
    } else {
      log.info('intake', 'command', { scope, droppedPending: 0 });
    }
    recordAccepted(ledger, emsg);
    return;
  }

  const size = pending.push(scope, emsg);
  log.info('intake', 'queued', { scope, queueSize: size, debounceMs: DEBOUNCE_MS });
  recordAccepted(ledger, emsg);
}

function recordAccepted(ledger: BackfillLedger | undefined, msg: NormalizedMessage): void {
  if (!ledger) return;
  const createTime = messageCreateTime(msg) ?? Date.now();
  ledger.record(msg.messageId, createTime);
}

function messageCreateTime(msg: NormalizedMessage): number | undefined {
  return typeof msg.createTime === 'number' && Number.isFinite(msg.createTime)
    ? msg.createTime
    : undefined;
}

function unrecordAcceptedMessages(ledger: BackfillLedger, messages: NormalizedMessage[]): void {
  let earliest: number | undefined;
  for (const msg of messages) {
    ledger.unrecord(msg.messageId);
    const createTime = messageCreateTime(msg);
    if (createTime === undefined) continue;
    earliest = earliest === undefined ? createTime : Math.min(earliest, createTime);
  }
  if (earliest !== undefined) ledger.markScanIncomplete(earliest);
}

function abandonUnstartedPending(
  pending: PendingQueue,
  ledger: BackfillLedger | undefined,
): NormalizedMessage[] {
  const dropped = pending.cancelAll();
  if (!ledger || dropped.length === 0) return dropped;
  unrecordAcceptedMessages(ledger, dropped);
  log.info('pending', 'handoff', {
    count: dropped.length,
    incompleteFrom: ledger.getIncompleteFrom(),
  });
  return dropped;
}

function markClosingArrival(
  ledger: BackfillLedger | undefined,
  msg: NormalizedMessage,
): void {
  if (!ledger) return;
  const createTime = messageCreateTime(msg) ?? Date.now();
  ledger.markScanIncomplete(createTime);
  log.info('pending', 'handoff', {
    count: 1,
    reason: 'closing',
    incompleteFrom: ledger.getIncompleteFrom(),
  });
}

interface RunBatchDeps {
  pluginCatalog: PluginCatalog;
  channel: LarkChannel;
  executor: RunExecutor;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  media: MediaCache;
  batch: NormalizedMessage[];
  controls: Controls;
  cotClient: CotClient;
  callbackAuth?: CallbackAuth;
  activePolicyFingerprints: Map<string, string>;
  lastRunModelByScope: Map<string, string>;
  canRecordSession(): boolean;
  scope: string;
  mode: ChatMode;
  backfillMarks: Map<string, BackfillMark>;
  ledger?: BackfillLedger;
  journal?: TurnJournal;
  noticeAuth?: NoticeActionAuth;
  continuations: Continuations;
  cliSelfSent?: CliSelfSendTracker;
  link?: { outageEpoch(): number; isDown(): boolean };
  onDeliveryWait?: (delayMs?: number) => void;
  outboundTimeoutMs: number;
  automations?: AutomationsStore;
  autoAuth?: AutoActionAuth;
  automationsScheduler?: AutomationScheduler;
  now?: () => number;
}

async function runAgentBatch(deps: RunBatchDeps): Promise<void> {
  const {
    channel,
    executor,
    sessions,
    sessionCatalog,
    workspaces,
    media,
    batch,
    controls,
    cotClient,
    callbackAuth,
    activePolicyFingerprints,
    lastRunModelByScope,
    scope,
    mode,
    backfillMarks,
    ledger,
    journal,
    noticeAuth,
    continuations,
    cliSelfSent,
    link,
    onDeliveryWait,
    outboundTimeoutMs,
    automations,
    autoAuth,
    automationsScheduler,
    now,
  } = deps;
  if (batch.length === 0) return;
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return;

  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;

  const resourceItems = batch.flatMap((m) =>
    m.resources.map((r) => ({
      messageId: journalResourceSourceId(r) ?? m.messageId,
      resource: r,
    })),
  );
  const attachments = await media.resolve(resourceItems, controls.profileConfig.attachments);
  if (attachments.length > 0) {
    log.info('media', 'resolved', { count: attachments.length });
    for (const attachment of attachments) {
      log.info('attachment', 'decision', {
        decision: attachment.decision,
        kind: attachment.kind,
        hash: attachment.hash,
        size: attachment.size,
        sourceMessageId: attachment.sourceMessageId,
        reason: attachment.rejectionReason,
      });
    }
  }

  // Collect any reply-quote targets in the batch. Dedup so the same target
  // quoted by multiple messages in one batch only fetches once. Filter out
  // ids that are themselves in the batch — those are already in the prompt.
  const batchIds = new Set(batch.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      batch
        .map((m) => replyQuoteTargetForMessage(m, mode))
        .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
    ),
  ];
  const quotes: QuotedContext[] = [];
  for (const targetId of quoteTargets) {
    const q = await fetchQuotedContext(channel, targetId);
    if (q) {
      quotes.push(q);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }

  // Topic upstream context. When this CLI has no session for the topic scope,
  // the thread's earlier messages — the root question that may never have
  // @-mentioned the bot, plus prior replies — live nowhere the agent can see
  // them. Fetch them so it isn't blind to what the user is pointing at. An
  // already-engaged topic for this CLI keeps that history in its resumed
  // session, so we skip the fetch there. Lookup must use the same source of
  // truth as resume: catalog for thread-resume CLIs (Codex), SessionStore for
  // session-resume CLIs. Another CLI's handle on the same thread must not
  // skip the fetch, because resume will not reuse that handle.
  const agentKind = controls.profileConfig.agentKind;
  const capability = capabilityForProfile(controls.profileConfig);
  const accessDecision =
    firstMsg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, firstMsg.senderId, firstMsg.chatId)
      : canUseGroup(controls.profileConfig, controls, firstMsg.chatId, firstMsg.senderId);
  let topicContext: QuotedContext[] = [];
  const topicResumeIdentity = mode === 'topic' && threadId
    ? await commandSessionCatalogIdentity({
        msg: firstMsg,
        scope,
        mode,
        workspaces,
        controls,
        access: accessDecision,
      })
    : undefined;
  const topicResumeHandle = topicResumeIdentity
    ? resolveRunResumeHandle({
        sessionCatalog,
        sessions,
        scopeId: scope,
        agentId: topicResumeIdentity.agentId,
        cwdRealpath: topicResumeIdentity.cwdRealpath,
        policyFingerprint: topicResumeIdentity.policyFingerprint,
      })
    : undefined;
  if (mode === 'topic' && threadId && !topicResumeHandle) {
    const exclude = new Set([...batchIds, ...quoteTargets]);
    topicContext = await fetchTopicContext(channel, threadId, {
      maxMessages: 40,
      excludeIds: exclude,
    });
    if (topicContext.length > 0) {
      log.info('topic', 'context-fetched', {
        scope,
        threadId,
        count: topicContext.length,
      });
    }
  }

  // Detect a model switch since this scope's last run. When resuming an
  // existing conversation the transcript still claims the old model, so tell
  // the (now-switched) agent its model changed — otherwise it keeps echoing
  // the previously-announced model. Only fires when a prior model was seen
  // for this scope (never on the first run) and the selection actually
  // changed. `requestedModel` (the `--model` value, or undefined for default)
  // is reused below to log requested-vs-actual against the init event.
  const modelPref = controls.profileConfig.preferences.model;
  const modelSelection = normalizeModelSelection(agentKind, modelPref);
  const requestedModel = resolveModelArg(agentKind, modelPref);
  const prevModel = lastRunModelByScope.get(scope);
  const modelSwitched = prevModel !== undefined && prevModel !== modelSelection;
  lastRunModelByScope.set(scope, modelSelection);
  const extraInstructions: string[] = [];
  const taken = await continuations.take(scope, batch);
  applyTakenInstruction(taken, extraInstructions);
  const catalog = deps.pluginCatalog;
  const automationPluginAvailable = await catalog.isAvailable('automation');
  const toolContext: ToolRunContext = {
    catalog, profile: controls.profile, chatId, actorId: lastMsg.senderId,
    runType: scope.startsWith('auto:') ? 'automation' : 'im', store: automations,
    timezone: controls.profileConfig.automations.timezone, agentTasks: controls.profileConfig.automations.agentTasks,
    cardReply: { replyTo: lastMsg.messageId, ...(mode === 'topic' && threadId ? { replyInThread: true, threadId } : {}) },
    cwd: workspaces.cwdFor(scope) ?? controls.profileConfig.workspaces.default,
    now, journal, drafts: { channel, automations, autoAuth, automationsScheduler, now, isLinkDown: () => Boolean(link?.isDown()), botAppId: controls.profileConfig.accounts.app.id },
    availability: () => !automationPluginAvailable ? 'automation-plugin-unavailable'
      : !controls.profileConfig.automations.enabled ? 'automations-disabled'
      : firstMsg.chatType === 'p2p' || mode === 'p2p' || scope.startsWith('meeting:') ? 'automation-requires-group'
      : senderTypeFromRaw((lastMsg as { raw?: unknown }).raw) !== 'user' ? 'automation-requires-human' : undefined,
  };
  extraInstructions.push(
    'Bridge plugins：共用入口为 lark-channel-bridge tool；客户端 JS 绝对路径在环境 LARK_BRIDGE_TOOL_CLIENT，用 node <该路径> tool 调用，按当前 shell 安全引用路径。' +
    '从 stdin 发送版本化 JSON（version:1, operation, params），stdout 是本轮实际工具结果。' +
    '按需 plugins.list、plugins.inspect（params.plugin）、plugins.read（params.skill）；唯一的插件/skill 名或别名可直达，歧义按候选选择。' +
    '资源读取使用 plugins.read 的 params.resource（包内路径）和 params.reference（读取结果的版本引用）；脚本按返回路径用 runtime 现有工具执行，遵守当前访问模式。旧引用失效需重新发现。' +
    '根据结果在本轮补字段或修正；最终回复由你负责。连接由环境提供，不得展示或保存运行凭据。创建提醒须以实际工具回执为准，人工确认后生效；其他变更按 schema 可用性处理。',
    `<bridge_plugins>${JSON.stringify({ plugins: await catalog.list(), diagnostics: catalog.diagnostics })}</bridge_plugins>`,
    `<bridge_run>${JSON.stringify({ profile: controls.profile, runType: toolContext.runType, now: (now ?? Date.now)(), timezone: toolContext.timezone, automationUnavailable: toolContext.availability() ?? (!automations ? 'automation-store-unavailable' : null) })}</bridge_run>`,
  );
  if (modelSwitched) {
    extraInstructions.push(
      `用户刚把本会话使用的模型切换为「${modelLabel(agentKind, modelPref)}」。` +
        '之前的对话里可能提到别的模型,请以当前模型为准;若被问到你用的是什么模型,据此回答。',
    );
  }
  const backfilled = consumeBackfillMarks(batch, backfillMarks);
  if (backfilled.length > 0) {
    const oldest = backfilled.reduce((current, msg) => (
      msg.createTime < current.createTime ? msg : current
    ));
    extraInstructions.push(formatBackfillLatenessHint({
      createTimeMs: oldest.createTime,
      nowMs: Date.now(),
    }));
  }

  const promptBatch = taken.kind === 'continue' && !taken.resumeHandle && taken.userInput
    ? [{ ...lastMsg, content: taken.userInput }]
    : batch;
  const prompt = buildPrompt(
    promptBatch,
    attachments,
    quotes,
    topicContext,
    channel.botIdentity,
    extraInstructions.length > 0 ? extraInstructions : undefined,
  );
  log.info('prompt', 'built', {
    promptChars: prompt.length,
    quotes: quotes.length,
    topicContext: topicContext.length,
    ...(modelSwitched ? { modelSwitchedTo: modelSelection } : {}),
    ...(backfilled.length > 0 ? { backfilled: backfilled.length } : {}),
  });

  // For topic groups: thread the reply so it lands in the same topic as the
  // user's message. Otherwise the SDK posts at top level and the user's
  // topic discussion breaks visually.
  const sendOpts = {
    replyTo: lastMsg.messageId,
    ...(mode === 'topic' && threadId ? { replyInThread: true } : {}),
  };
  log.info('flush', 'reply-target', {
    scope,
    mode,
    chatId,
    threadId,
    replyTo: sendOpts.replyTo,
    replyInThread: sendOpts.replyInThread === true,
  });

  const scopeContext: ScopeContext = {
    source: 'im',
    chatId,
    actorId: firstMsg.senderId,
    ...(threadId && !isAutomationRunScope(scope) ? { threadId } : {}),
  };
  const turnId = journal ? randomUUID() : undefined;
  if (journal && turnId) {
    const initiatorType = senderTypeOf(lastMsg);
    journal.enqueue({
      turnId,
      scope,
      chatId,
      ...(threadId ? { threadId } : {}),
      messageIds: batch.map((msg) => msg.messageId),
      senderId: firstMsg.senderId,
      initiatorId: lastMsg.senderId,
      ...(initiatorType ? { initiatorType } : {}),
      status: 'queued',
      userInput: promptBatch.map((msg) => msg.content).filter(Boolean).join('\n\n'),
      ...journalResources(batch),
    });
  }

  const flow = await startRunFlow({
    toolContext,
    scopeId: scope,
    scope: scopeContext,
    prompt,
    attachments: attachments.map(toPolicyAttachment),
    access: accessDecision,
    capability,
    profileConfig: controls.profileConfig,
    sessions,
    sessionCatalog,
    workspaces,
    executor,
    now: Date.now(),
    stopGraceMs: getAgentStopGraceMs(controls.cfg),
    ...(taken.kind === 'continue'
      ? taken.resumeHandle
        ? {
          forceResumeHandle: taken.resumeHandle,
          ...(taken.policyFingerprint
            ? { forceResumeFingerprint: taken.policyFingerprint }
            : {}),
        }
        : { forceResumeHandle: null }
      : {}),
    observability: {
      profile: controls.profile,
      agent: capability.agentId,
      source: 'im',
      stage: 'submit',
    },
  });
  if (!flow.ok) {
    log.info('run-flow', 'rejected', { scope, code: flow.rejectReason.code });
    log.warn('policy', 'denied', {
      scope,
      source: 'im',
      code: flow.rejectReason.code,
    });
    if (
      flow.rejectReason.code === 'reconnect-in-progress'
      && ledger
    ) {
      unrecordAcceptedMessages(ledger, batch);
      log.info('pending', 'handoff', {
        count: batch.length,
        reason: 'reconnect-in-progress',
        incompleteFrom: ledger.getIncompleteFrom(),
      });
    }
    await channel.send(chatId, { markdown: flow.rejectReason.userVisible }, sendOpts);
    if (journal && turnId) journal.voidTurn(turnId);
    return;
  }

  const { execution, cwdRealpath: cwd } = flow;
  activePolicyFingerprints.set(scope, flow.policy.policyFingerprint);
  if (journal && turnId) {
    journal.noteTurnMeta(turnId, {
      ...(flow.resumeFrom ? { resumeHandle: flow.resumeFrom } : {}),
      policyFingerprint: flow.policy.policyFingerprint,
    });
  }
  const handle = execution.handle;
  const eventStream = execution.subscribe();
  const noticeCtx = journal && !isAutomationRunScope(scope)
    ? {
        enabled: true as const,
        auth: noticeAuth,
        continuations,
        ownerId: controls.botOwnerId,
        requireBotMention: lastMsg.chatType !== 'p2p'
          && requireMentionForChat(controls.profileConfig, controls.cfg, lastMsg.chatId),
      }
    : undefined;
  if (flow.resumeFrom) {
    log.info('session', 'resume', { resumeHandle: flow.resumeFrom, cwd });
  } else {
    log.info('session', 'fresh', { cwd });
  }
  const recordSession = (evt: AgentEvent): void => {
    if (!deps.canRecordSession()) return;
    recordRunSessionEvent({
      scopeId: scope,
      sessions,
      sessionCatalog,
      capability,
      policy: flow.policy,
      event: evt,
    });
    if (evt.type === 'system' && evt.resumeHandle) {
      log.info('session', 'set', { resumeHandle: evt.resumeHandle });
      if (journal && turnId) journal.noteTurnMeta(turnId, { resumeHandle: evt.resumeHandle });
    }
    // Ground truth for "which model is actually running": claude reports the
    // model it loaded in its init event. Logging requested-vs-actual reveals
    // whether the --model pin took effect or claude silently fell back (e.g.
    // an id this claude build/account doesn't recognize).
    if (evt.type === 'system' && evt.model) {
      log.info('session', 'model', {
        requested: requestedModel ?? 'default',
        actual: evt.model,
      });
    }
  };

  // Resolve idle-timeout for this run: scope override (on SessionEntry) wins
  // over global default (preferences, unset = 15 min). 0 = no watchdog.
  const scopeOverride = sessions.getIdleTimeoutMinutes(scope);
  const idleTimeoutMs =
    scopeOverride !== undefined
      ? scopeOverride > 0
        ? scopeOverride * 60_000
        : undefined
      : getRunIdleTimeoutMs(controls.cfg);
  if (idleTimeoutMs) {
    log.info('flush', 'idle-watchdog', { idleTimeoutMs });
  }

  const replyMode = getMessageReplyMode(controls.cfg);
  const finalAnswerOnly =
    descriptorFor(controls.profileConfig.agentKind).replyMode === 'final-answer';
  const runContext = {
    currentChatId: chatId,
    batchMessageIds: batch.map((msg) => msg.messageId),
  };
  log.info('flush', 'reply-mode', { mode: replyMode });
  const cotMessages = getCotMessages(controls.cfg);
  const cotEnabled = cotMessages !== 'off';
  const triggerSenderType = senderTypeFromRaw((lastMsg as { raw?: unknown }).raw);
  const automationReply = controls.profileConfig.automations.enabled
    ? {
        honor: () => !execution.usedBridgeTools() && shouldHonorAutomationProposal({
          enabled: true,
          scope,
          senderId: lastMsg.senderId,
          ...(triggerSenderType ? { senderType: triggerSenderType } : {}),
          ...(channel.botIdentity?.openId ? { botOpenId: channel.botIdentity.openId } : {}),
        }),
        plan: (parsed: AutomationProposalFields): AutomationProposalVerdict => {
          const taskType = parsed.op === 'delete' ? 'reminder' : parsed.taskType;
          const cwd = parsed.op !== 'delete' && taskType === 'agent'
            ? workspaces.cwdFor(scope) ?? controls.profileConfig.workspaces.default
            : undefined;
          const target = parsed.op === 'create' ? undefined : automations?.get(parsed.id);
          return planAutomationProposalReply({
            proposal: parsed,
            now: (now ?? Date.now)(),
            timezone: controls.profileConfig.automations.timezone,
            agentTasks: controls.profileConfig.automations.agentTasks,
            hasCwd: parsed.op === 'delete' || taskType !== 'agent' || (typeof cwd === 'string' && cwd.trim().length > 0),
            group: mode !== 'p2p' && lastMsg.chatType !== 'p2p',
            canSave: parsed.op === 'create'
              ? Boolean(automations && autoAuth)
              : Boolean(automations && autoAuth && automationsScheduler),
            targetInChat: Boolean(target && target.chatId === lastMsg.chatId),
          });
        },
        clock: (): RejectionExampleClock => ({
          now: (now ?? Date.now)(),
          timezone: controls.profileConfig.automations.timezone,
        }),
        apply: (parsed: AutomationProposalFields): Promise<ReplaceProposalApplyResult | void> => {
          const proposalCtx = {
            channel,
            msg: lastMsg,
            scope,
            chatMode: mode,
            workspaces,
            automations,
            autoAuth,
            automationsScheduler,
            ...(now ? { now } : {}),
            isLinkDown: () => Boolean(link?.isDown()),
            controls,
          };
          switch (parsed.op) {
            case 'delete':
              return submitAutomationDeleteProposal(proposalCtx, parsed);
            case 'replace':
              return submitAutomationReplaceProposal(proposalCtx, parsed);
            case 'create':
              return submitAutomationProposal(proposalCtx, {
                taskType: parsed.taskType,
                scheduleText: parsed.scheduleText,
                name: parsed.name,
                taskText: parsed.taskText,
              }, 'proposal');
            default: {
              const _exhaustive: never = parsed;
              return _exhaustive;
            }
          }
        },
      }
    : undefined;

  // Re-read prefs on every flush so toggling /config mid-stream takes
  // effect immediately. Cheap object lookups, no allocation when on.
  const filterForPrefs = (state: RunState): RunState => {
    const withoutTools = getShowToolCalls(controls.cfg)
      ? state
      : { ...state, blocks: state.blocks.filter((b) => b.kind !== 'tool') };
    return automationReply ? stripProposalFromState(withoutTools) : withoutTools;
  };
  const cardRenderOptions = callbackAuth
    ? {
        signCallback: (action: string) =>
          callbackAuth.sign({
            runId: execution.runId,
            scope,
            chatId,
            operatorOpenId: firstMsg.senderId,
            action,
            policyFingerprint: flow.policy.policyFingerprint,
            ttlMs: 24 * 60 * 60 * 1000,
          }),
      }
    : {};

  // For non-card modes Claude's output doesn't surface visually until either
  // a first streamed token (markdown mode) or the whole run ends (text mode).
  // Add a "Typing" reaction to the triggering message as an instant ack, but
  // never let that outbound API call block agent event draining.
  const reactionPromise =
    cotEnabled || replyMode === 'card' ? undefined : addWorkingReaction(channel, lastMsg.messageId);

  const onNotInChat = (chatId: string): Promise<unknown> => (
    automationsScheduler?.removeFromChat(chatId) ?? Promise.resolve()
  );
  cliSelfSent?.begin(scope, turnId);
  try {
    if (cotEnabled) {
      const cotPublisher = new CotPublisher({
        client: cotClient,
        chatId,
        // The CoT bubble follows this origin message's thread. In a topic the
        // triggering message is itself in-topic, so the bubble lands in the
        // topic; message_cot has no thread_id receive type, so origin is the
        // only lever we have (see CotClient.create).
        originMessageId: lastMsg.messageId,
        runId: execution.runId,
        scope,
        inputPreview: lastMsg.content,
      });
      await cotPublisher.start();
      if (!cotPublisher.disabled) {
        const cotDone = consumeCotEvents(execution.subscribe(), cotPublisher, {
          detail: cotMessages,
        });
        const finalState = await processAgentStream(
          handle,
          eventStream,
          scope,
          idleTimeoutMs,
          recordSession,
          async () => {},
          runContext,
          streamReliability(controls.profileConfig, () => link),
        );
        await cotDone;
        if (cotPublisher.degradedReason) {
          await sendCotDegradedNotice({
            channel,
            chatId,
            scope,
            sendOpts,
            reason: cotPublisher.degradedReason,
            journal,
            turnId,
          });
        }
        await deliverFinalReply({
          channel,
          chatId,
          scope,
          state: finalAnswerOnlyState(finalState),
          skipFrom: finalState,
          replyMode,
          sendOpts,
          cardRenderOptions,
          journal,
          turnId,
          handle,
          notice: noticeCtx,
          cliSelfSent,
          link,
          onWait: onDeliveryWait,
          onNotInChat,
          ...(automationReply ? { automation: automationReply } : {}),
        });
        return;
      }
      log.warn('cot', 'fallback-existing-reply', { reason: 'create-disabled' });
    }

    if (replyMode === 'card') {
      let latestState: RunState = seedRunState(runContext);
      let producerStarted = false;
      let producerRendered = false;
      let cardCtrl:
        | { messageId?: string; update(next: object | ((current: object) => object)): Promise<void> }
        | undefined;
      const progress = createLazyProgressStream(scope, replyMode, () =>
        channel.stream(
          chatId,
          {
            card: {
              initial: renderCard(initialState, cardRenderOptions),
              producer: async (ctrl) => {
                producerStarted = true;
                progress.noteMessageId(ctrl.messageId);
                if (progress.abandoned()) return;
                cardCtrl = ctrl;
                const visible = filterForPrefs(latestState);
                await ctrl.update(renderCard(visible, cardRenderOptions));
                producerRendered = true;
                await renderDone;
              },
            },
          },
          withDeliveryUuid(sendOpts, turnId ? streamDeliveryKey(turnId) : undefined),
        ),
      );
      const renderDone = processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async (state) => {
          latestState = state;
          if (shouldOpenProgressStream(filterForPrefs(state))) progress.ensureOpen();
          if (cardCtrl) {
            try {
              const visible = filterForPrefs(state);
              await cardCtrl.update(renderCard(visible, cardRenderOptions));
            } catch (err) {
              log.fail('stream', err, { mode: replyMode, step: 'render' });
            }
          }
        },
        runContext,
        streamReliability(controls.profileConfig, () => link),
      );
      const stream = await awaitRenderAwareStream({
        mode: replyMode,
        progress,
        renderDone,
        producerStarted: () => producerStarted,
        producerRendered: () => producerRendered,
        timeoutMs: outboundTimeoutMs,
      });
      await recallIfEmptyStreamedReply(channel, progress, filterForPrefs(latestState), scope);
      const visible = filterForPrefs(latestState);
      const terminalState = finalAnswerOnly
        ? finalReplyState(stream, visible)
        : finalReplyFor(visible, { replyMode: 'stream-deltas', streamed: false });
      await deliverFinalReply({
        channel,
        chatId,
        scope,
        state: terminalState,
        skipFrom: latestState,
        stream,
        dedicatedFinal: finalAnswerOnly,
        replyMode,
        sendOpts,
        cardRenderOptions,
        journal,
        turnId,
        handle,
        notice: noticeCtx,
        cliSelfSent,
        link,
        onWait: onDeliveryWait,
        onNotInChat,
        ...(automationReply ? { automation: automationReply } : {}),
      });
    } else if (replyMode === 'markdown') {
      let latestState: RunState = seedRunState(runContext);
      let producerStarted = false;
      let producerRendered = false;
      let markdownCtrl: { messageId?: string; setContent(markdown: string): Promise<void> } | undefined;
      const progress = createLazyProgressStream(scope, replyMode, () =>
        channel.stream(
          chatId,
          {
            markdown: async (ctrl) => {
              producerStarted = true;
              progress.noteMessageId(ctrl.messageId);
              if (progress.abandoned()) return;
              markdownCtrl = ctrl;
              const visible = filterForPrefs(latestState);
              await ctrl.setContent(renderText(visible));
              producerRendered = true;
              await renderDone;
            },
          },
          withDeliveryUuid(sendOpts, turnId ? streamDeliveryKey(turnId) : undefined),
        ),
      );
      const renderDone = processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async (state) => {
          latestState = state;
          if (shouldOpenProgressStream(filterForPrefs(state))) progress.ensureOpen();
          if (markdownCtrl) {
            try {
              const visible = filterForPrefs(state);
              await markdownCtrl.setContent(renderText(visible));
            } catch (err) {
              log.fail('stream', err, { mode: replyMode, step: 'render' });
            }
          }
        },
        runContext,
        streamReliability(controls.profileConfig, () => link),
      );
      const stream = await awaitRenderAwareStream({
        mode: replyMode,
        progress,
        renderDone,
        producerStarted: () => producerStarted,
        producerRendered: () => producerRendered,
        timeoutMs: outboundTimeoutMs,
      });
      await recallIfEmptyStreamedReply(channel, progress, filterForPrefs(latestState), scope);
      const visible = filterForPrefs(latestState);
      const terminalState = finalAnswerOnly
        ? finalReplyState(stream, visible)
        : finalReplyFor(visible, { replyMode: 'stream-deltas', streamed: false });
      await deliverFinalReply({
        channel,
        chatId,
        scope,
        state: terminalState,
        skipFrom: latestState,
        stream,
        dedicatedFinal: finalAnswerOnly,
        replyMode,
        sendOpts,
        cardRenderOptions,
        journal,
        turnId,
        handle,
        notice: noticeCtx,
        cliSelfSent,
        link,
        onWait: onDeliveryWait,
        onNotInChat,
        ...(automationReply ? { automation: automationReply } : {}),
      });
    } else {
      // text mode: drain the agent stream without sending anything during
      // the run, then post the final rendered text once as a plain markdown
      // (msg_type=post) message — no card, no streaming, no typewriter.
      const finalState = await processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async () => {},
        runContext,
        streamReliability(controls.profileConfig, () => link),
      );
      await deliverFinalReply({
        channel,
        chatId,
        scope,
        state: finalReplyFor(filterForPrefs(finalState), {
          replyMode: finalAnswerOnly ? 'final-answer' : 'stream-deltas',
          streamed: false,
        }),
        skipFrom: finalState,
        replyMode,
        sendOpts,
        cardRenderOptions,
        journal,
        turnId,
        handle,
        notice: noticeCtx,
        cliSelfSent,
        link,
        onWait: onDeliveryWait,
        onNotInChat,
        ...(automationReply ? { automation: automationReply } : {}),
      });
    }
  } catch (err) {
    log.fail('stream', err);
  } finally {
    cliSelfSent?.consume(scope);
    activePolicyFingerprints.delete(scope);
    scheduleWorkingReactionCleanup(channel, lastMsg.messageId, reactionPromise);
  }
}

type StreamDelivery =
  | { kind: 'confirmed'; messageId: string }
  | { kind: 'failed'; err: unknown; messageId?: string }
  | { kind: 'none' };

interface LazyProgressStream {
  /**
   * Mirrors the underlying `channel.stream(...)` promise, and stays pending
   * forever while no stream has been opened — so callers can race it against
   * the render loop exactly as if the stream had been created up front.
   */
  readonly settled: Promise<unknown>;
  opened(): boolean;
  ensureOpen(): void;
  /**
   * True once the reply went out without this stream. A producer that starts
   * after that must render nothing, or the user gets the same answer twice.
   */
  abandoned(): boolean;
  abandon(): void;
  messageId(): string | undefined;
  noteMessageId(id: string | undefined): void;
}

/**
 * Wrap a progress stream so the user-visible message is only created once the
 * run has something worth showing (see `shouldOpenProgressStream`).
 *
 * The SDK starts a stream eagerly: `channel.stream(...)` sends a card before
 * the producer runs, and finishes it with a "(no content)" placeholder when the
 * producer never supplied any text. A Codex round that only produces a final
 * answer (delivered separately by `sendFinalReply`) used to hit exactly that:
 * an empty card sat in the chat for seconds until `recall-empty` cleaned it up.
 */
function createLazyProgressStream(
  scope: string,
  mode: 'card' | 'markdown',
  open: () => Promise<unknown>,
): LazyProgressStream {
  let stream: Promise<unknown> | undefined;
  let givenUp = false;
  let createdId: string | undefined;
  let settle!: (result: Promise<unknown>) => void;
  const settled = new Promise<unknown>((resolve, reject) => {
    settle = (result) => {
      result.then(resolve, reject);
    };
  });
  return {
    settled,
    opened: () => stream !== undefined,
    ensureOpen: () => {
      if (stream) return;
      log.info('outbound', 'progress-stream-open', { scope, mode });
      stream = open();
      settle(stream);
    },
    abandoned: () => givenUp,
    abandon: () => {
      givenUp = true;
    },
    messageId: () => createdId,
    noteMessageId: (id) => {
      if (id) createdId = id;
    },
  };
}

/**
 * Is there anything in this state that will still be on screen when the run
 * ends? Footer status lines ("正在思考…") don't count: the terminal event drops
 * them, so a stream opened for a footer alone can still finish empty — which is
 * the placeholder-then-recall churn we're avoiding.
 *
 * Terminal states don't count either. By then the stream has nothing left to
 * stream, and whatever the run produced goes out as a normal reply
 * (`sendFinalReply`) instead of a card that would be created only to be
 * finished a moment later.
 *
 * `state` must already be `filterForPrefs`-projected, and emptiness is measured
 * with `renderText` in both reply modes so it matches the rule
 * `recallIfEmptyStreamedReply` applies: a stream we open is one that survives.
 */
function shouldOpenProgressStream(state: RunState): boolean {
  if (state.terminal !== 'running') return false;
  return renderText({ ...state, footer: null }).trim() !== '';
}

/**
 * What Codex's dedicated final reply may carry, given what the progress stream
 * already put on screen.
 *
 * `finalAnswerOnlyState` falls back to the run's text blocks when Codex held
 * nothing back for the end — correct where nothing was streamed (CoT, text
 * mode, a stream we gave up on), but those blocks are already visible once a
 * stream rendered them, and repeating them posts the same words a second time.
 * Codex leaves the answer in `blocks` more often than it looks: any abnormal
 * turn end (`turn.failed`, or the process exiting before `turn.completed`)
 * flushes the pending message as text instead of `final_text`.
 *
 * Terminal notices are dropped for the same reason — the stream rendered them.
 */
function finalReplyState(stream: StreamDelivery, state: RunState): RunState {
  return finalReplyFor(state, {
    replyMode: 'final-answer',
    streamed: stream.kind === 'confirmed',
  });
}

/**
 * Backstop for a progress stream that was opened on real content and still
 * ended up empty — e.g. `/config` hiding tool calls mid-run, which retroactively
 * empties a tool-only render. The SDK fills such a card with its "(no content)"
 * placeholder, so recall it instead of leaving noise in the chat.
 *
 * `finalState` must already be `filterForPrefs`-projected (what the user sees).
 */
async function recallIfEmptyStreamedReply(
  channel: LarkChannel,
  progress: LazyProgressStream,
  finalState: RunState,
  scope: string,
): Promise<void> {
  if (!progress.opened()) return;
  // An abandoned stream renders nothing, so whatever message it eventually
  // posts is empty by construction. It is still in flight (that is why we gave
  // up on it), so clean up in the background instead of blocking the run on it.
  if (progress.abandoned()) {
    void progress.settled.then(
      (result) => recallStreamedMessage(channel, result, scope),
      () => {},
    );
    return;
  }
  if (renderText(finalState).trim() !== '') return;
  const result = await progress.settled.catch(() => undefined);
  await recallStreamedMessage(channel, result, scope);
}

async function recallStreamedMessage(
  channel: LarkChannel,
  streamResult: unknown,
  scope: string,
): Promise<void> {
  const messageId = (streamResult as { messageId?: string } | undefined)?.messageId;
  if (!messageId) return;
  try {
    await channel.recallMessage(messageId);
    log.info('outbound', 'recall-empty', { scope, messageId });
  } catch (err) {
    log.warn('outbound', 'recall-empty-failed', {
      scope,
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function threadIdForReply(
  journal: TurnJournal,
  turnId: string,
): { threadId: string } | Record<string, never> {
  const threadId = journal.get(turnId)?.threadId?.trim();
  return threadId ? { threadId } : {};
}

async function deliverFinalReply(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  state: RunState;
  skipFrom?: RunState;
  stream?: StreamDelivery;
  dedicatedFinal?: boolean;
  replyMode: ReturnType<typeof getMessageReplyMode>;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  cardRenderOptions: { signCallback?: (action: string) => string };
  journal?: TurnJournal;
  turnId?: string;
  handle: RunHandle;
  notice?: {
    enabled: true;
    auth?: NoticeActionAuth;
    continuations: Continuations;
    ownerId?: string;
    requireBotMention: boolean;
  };
  cliSelfSent?: CliSelfSendTracker;
  link?: { isDown(): boolean };
  onWait?: (delayMs?: number) => void;
  onNotInChat?: (chatId: string) => void | Promise<unknown>;
  automation?: {
    honor: boolean | (() => boolean);
    plan: (parsed: AutomationProposalFields) => AutomationProposalVerdict;
    clock: () => RejectionExampleClock;
    apply: (parsed: AutomationProposalFields) => Promise<ReplaceProposalApplyResult | void>;
  };
}): Promise<void> {
  if (input.journal && input.turnId && input.handle.outcome) {
    input.journal.markSettled(input.turnId, input.handle.outcome);
  }
  const extracted = input.automation
    ? extractAutomationProposal(proposalTextFromState(input.skipFrom ?? input.state))
    : undefined;
  const state = extracted?.tagged ? stripProposalFromState(input.state) : input.state;
  const skipFrom = extracted?.tagged && input.skipFrom
    ? stripProposalFromState(input.skipFrom)
    : input.skipFrom;
  const parsed = extracted?.parsed;
  const honor = typeof input.automation?.honor === 'function' ? input.automation.honor() : input.automation?.honor === true;
  const completed = state.terminal === 'done' || input.handle.outcome?.kind === 'completed';
  let proposalSuffix: string | undefined;
  let deliverProposal = false;
  if (parsed && input.automation && honor && completed) {
    const verdict = input.automation.plan(parsed);
    proposalSuffix = automationProposalSuffix(verdict, parsed, input.automation.clock());
    switch (verdict.outcome) {
      case 'confirm':
      case 'needs-end':
      case 'delete':
        deliverProposal = true;
        break;
      case 'reject':
        noteAutomationRejected(verdict.reason, 'proposal');
        break;
      case 'unknown-id':
        log.info('auto', 'rejected', {
          reason: 'unknown-id',
          source: 'proposal',
          ...(parsed.op === 'create' ? {} : { id: parsed.id }),
        });
        break;
      case 'refuse':
        break;
      default: {
        const _exhaustive: never = verdict;
        return _exhaustive;
      }
    }
  }
  const unaugmented = renderText(state);
  const baseState = unaugmented.trim() ? state : (skipFrom ?? state);
  const replyState = proposalSuffix ? appendReplyLine(baseState, proposalSuffix) : baseState;
  const applyAutomationProposal = async (): Promise<void> => {
    if (!parsed || !input.automation) return;
    if (!honor) {
      log.info('auto', 'proposal-ignored', { scope: input.scope });
      return;
    }
    if (!deliverProposal) return;
    const applied = await input.automation.apply(parsed);
    const nextLine = replaceProposalLineAfterApply(proposalSuffix, parsed, applied);
    if (nextLine === proposalSuffix || !proposalSuffix) return;
    await reconcileReplacePromise({
      channel: input.channel,
      chatId: input.chatId,
      replyMode: input.replyMode,
      cardRenderOptions: input.cardRenderOptions,
      journal: input.journal,
      turnId: input.turnId,
      state: replyState,
      plannedSuffix: proposalSuffix,
      replacement: nextLine,
      sendOpts: input.sendOpts,
      onNotInChat: input.onNotInChat,
    });
  };
  const visibleBody = renderText(replyState);
  const cliSent = input.cliSelfSent?.has(input.scope) === true
    && (input.skipFrom ?? input.state).terminal === 'done';
  const skipCli = shouldSkipFinalReply(input.skipFrom ?? input.state, input.chatId) || cliSent;
  const skip = skipCli || !visibleBody.trim();
  if (input.journal && input.turnId && skipCli) {
    input.journal.noteCliAlreadySent(input.turnId);
  }
  const outcome = input.handle.outcome;
  const willNotice = Boolean(
    input.notice && input.journal && input.turnId && outcome && planInterruptionNotice(outcome).kind !== 'none',
  );
  const deliveryId = input.turnId
    ? input.journal?.get(input.turnId)?.reply?.deliveryId ?? replyDeliveryKey(input.turnId)
    : undefined;
  const stream = input.stream ?? { kind: 'none' as const };
  const dedicatedFinal = input.dedicatedFinal === true && Boolean(unaugmented.trim());
  const streamMessageId = stream.kind === 'none' ? undefined : stream.messageId;
  if (dedicatedFinal && streamMessageId && input.journal && input.turnId) {
    input.journal.noteNonAnswerId(input.turnId, streamMessageId);
  }
  const reply = {
    markdown: visibleBody,
    replyTo: input.sendOpts.replyTo,
    replyMode: input.replyMode,
    ...(input.sendOpts.replyInThread ? { replyInThread: true } : {}),
    ...(input.journal && input.turnId ? threadIdForReply(input.journal, input.turnId) : {}),
    ...(deliveryId ? { deliveryId } : {}),
    ...(!dedicatedFinal && streamMessageId ? { messageId: streamMessageId, interactive: true as const } : {}),
  };
  if (input.journal && input.turnId && !skip) {
    input.journal.stageReply(input.turnId, reply);
  }
  if (willNotice && input.notice && input.journal && input.turnId && outcome) {
    stageTurnNotice({
      journal: input.journal,
      turnId: input.turnId,
      scope: input.scope,
      outcome,
      notice: input.notice,
    });
  }
  // The stream card is already on screen. Persist the journal after the
  // in-memory delivery mark so a slow fsync cannot leave readers on
  // `completed-undelivered` for the whole write.
  const deferJournalFlush = stream.kind === 'confirmed' && !dedicatedFinal;
  if (input.journal && !deferJournalFlush) await input.journal.flush();
  if (skipCli) {
    log.info('outbound', 'skip-cli-already-sent', {
      scope: input.scope,
      chatId: input.chatId,
      mode: input.replyMode,
    });
    reportMetric(OUTBOUND_SKIP_CLI_SENT_METRIC, 1);
  } else if (skip && stream.kind === 'none') {
    log.info('outbound', 'skip-empty', { scope: input.scope, mode: input.replyMode });
  } else if (input.link?.isDown()) {
    if (deferJournalFlush && input.journal) await input.journal.flush();
    await applyAutomationProposal();
    return;
  } else {
    try {
      if (
        proposalSuffix
        && stream.kind === 'confirmed'
        && stream.messageId
        && !dedicatedFinal
      ) {
        await input.channel.updateCard(
          stream.messageId,
          settledReplyCard(input.replyMode, replyState, visibleBody, input.cardRenderOptions),
        );
      }
      const settled = await settleStreamDelivery({
        stream,
        channel: input.channel,
        body: visibleBody,
        send: () => sendFinalReply({
          ...input,
          deliveryId,
          state: replyState,
        }),
        fallback: () => sendPlainTextReply({
          channel: input.channel,
          chatId: input.chatId,
          body: visibleBody,
          sendOpts: input.sendOpts,
          deliveryId,
        }),
        journal: input.journal,
        turnId: input.turnId,
        replyMode: input.replyMode,
        dedicatedFinal,
      });
      if (settled.kind === 'wait') {
        if (deferJournalFlush && input.journal) await input.journal.flush();
        input.onWait?.(rateLimitResetDelayMs(settled.error));
        await applyAutomationProposal();
        return;
      }
    } catch (error) {
      if (deferJournalFlush && input.journal) await input.journal.flush();
      if (!isNotInChat(error)) throw error;
      return;
    }
  }
  if (input.journal && input.turnId) input.journal.replyDelivered(input.turnId);
  if (deferJournalFlush && input.journal) await input.journal.flush();
  if (willNotice && input.notice && input.journal && input.turnId && outcome) {
    await sendTurnNotice({
      channel: input.channel,
      journal: input.journal,
      turnId: input.turnId,
      scope: input.scope,
      outcome,
      notice: input.notice,
      link: input.link,
      onWait: input.onWait,
    });
  }
  await applyAutomationProposal();
}

type OutboundSettle = { kind: 'done' } | { kind: 'wait'; error?: unknown };

function settledReplyCard(
  replyMode: ReturnType<typeof getMessageReplyMode>,
  state: RunState,
  markdown: string,
  cardRenderOptions: { signCallback?: (action: string) => string },
): object {
  switch (replyMode) {
    case 'card':
      return renderCard(state, cardRenderOptions);
    case 'markdown':
    case 'text':
      return {
        schema: '2.0',
        body: { elements: [{ tag: 'markdown', content: markdown }] },
      };
    default: {
      const _exhaustive: never = replyMode;
      return _exhaustive;
    }
  }
}

function stateWithoutProposalLine(
  state: RunState,
  promise: string,
  replacement: string | undefined,
): RunState {
  const needle = promise.trim();
  let index = -1;
  for (let i = state.blocks.length - 1; i >= 0; i -= 1) {
    const block = state.blocks[i];
    if (block?.kind === 'text' && block.content.trim() === needle) {
      index = i;
      break;
    }
  }
  if (index < 0) return state;
  const blocks = state.blocks.slice();
  if (!replacement) {
    blocks.splice(index, 1);
    return { ...state, blocks };
  }
  const block = blocks[index];
  if (block?.kind !== 'text') return state;
  blocks[index] = { ...block, content: replacement };
  return { ...state, blocks };
}

async function reconcileReplacePromise(input: {
  channel: LarkChannel;
  chatId: string;
  replyMode: ReturnType<typeof getMessageReplyMode>;
  cardRenderOptions: { signCallback?: (action: string) => string };
  journal?: TurnJournal;
  turnId?: string;
  state: RunState;
  plannedSuffix: string;
  replacement: string | undefined;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  onNotInChat?: (chatId: string) => void | Promise<unknown>;
}): Promise<void> {
  const corrected = stateWithoutProposalLine(input.state, input.plannedSuffix, input.replacement);
  if (corrected === input.state) return;
  const correctedBody = renderText(corrected);
  const entry = input.journal && input.turnId ? input.journal.get(input.turnId) : undefined;
  const reply = entry?.reply;
  if (!reply || reply.state !== 'sent') {
    if (input.journal && input.turnId && reply) {
      input.journal.stageReply(input.turnId, {
        markdown: correctedBody,
        replyTo: reply.replyTo,
        ...(reply.replyInThread ? { replyInThread: true } : {}),
        ...(reply.threadId ? { threadId: reply.threadId } : {}),
        replyMode: reply.replyMode,
        ...(reply.deliveryId ? { deliveryId: reply.deliveryId } : {}),
        ...(reply.messageId ? { messageId: reply.messageId } : {}),
        ...(reply.interactive ? { interactive: true } : {}),
      });
      await input.journal.flush();
    }
    return;
  }
  const interactive = reply.interactive === true || input.replyMode === 'card';
  const previousMessageId = reply.messageId;
  const canStage = Boolean(input.journal && input.turnId);
  if (interactive && previousMessageId) {
    if (canStage && input.journal && input.turnId) {
      await stageFailedPromiseCorrection({
        journal: input.journal,
        turnId: input.turnId,
        reply,
        correctedBody,
        interactive,
        previousMessageId,
      });
    }
    try {
      await input.channel.updateCard(
        previousMessageId,
        settledReplyCard(input.replyMode, corrected, correctedBody, input.cardRenderOptions),
      );
    } catch (error) {
      await keepOrRestorePromise(error, input, reply);
      return;
    }
    if (input.turnId) {
      input.journal?.reviseDeliveredReply(input.turnId, correctedBody);
      input.journal?.replyDelivered(input.turnId);
    }
    await input.journal?.flush();
    return;
  }
  if (previousMessageId) {
    if (canStage && input.journal && input.turnId) {
      await stageFailedPromiseCorrection({
        journal: input.journal,
        turnId: input.turnId,
        reply,
        correctedBody,
        interactive,
        previousMessageId,
      });
    }
    let sent: { messageId?: string };
    try {
      sent = await input.channel.send(
        input.chatId,
        { markdown: correctedBody },
        withDeliveryUuid({
          ...(input.sendOpts.replyTo ? { replyTo: input.sendOpts.replyTo } : {}),
          ...(input.sendOpts.replyInThread ? { replyInThread: true } : {}),
        }, input.turnId ? promiseCorrectionDeliveryKey(input.turnId) : undefined),
      );
    } catch (error) {
      await keepOrRestorePromise(error, input, reply);
      return;
    }
    const messageId = sent.messageId?.trim();
    if (input.journal && input.turnId && messageId) {
      input.journal.noteReplyReceipt(input.turnId, messageId);
      await input.journal.flush();
    }
    let recall: SupersedeRecall;
    try {
      recall = await recallReplacedMessage(input.channel, previousMessageId);
    } catch (error) {
      if (!isNotInChat(error)) throw error;
      if (input.turnId) input.journal?.replyRejected(input.turnId);
      await input.journal?.flush();
      await input.onNotInChat?.(input.chatId);
      return;
    }
    switch (recall) {
      case 'done':
        if (input.turnId) input.journal?.replyDelivered(input.turnId);
        break;
      case 'retry':
        break;
      default: {
        const _exhaustive: never = recall;
        throw _exhaustive;
      }
    }
    await input.journal?.flush();
    return;
  }
  log.warn('auto', 'promise-uncorrected', {});
}

async function keepOrRestorePromise(
  error: unknown,
  input: {
    journal?: TurnJournal;
    turnId?: string;
  },
  reply: NonNullable<TurnJournalEntry['reply']>,
): Promise<void> {
  if (classify(error) === 'link' && input.journal && input.turnId) return;
  if (input.journal && input.turnId && reply.messageId) {
    input.journal.stageReply(input.turnId, {
      markdown: reply.markdown,
      replyTo: reply.replyTo,
      ...(reply.replyInThread ? { replyInThread: true } : {}),
      ...(reply.threadId ? { threadId: reply.threadId } : {}),
      replyMode: reply.replyMode,
      ...(reply.deliveryId ? { deliveryId: reply.deliveryId } : {}),
      messageId: reply.messageId,
      ...(reply.interactive ? { interactive: true } : {}),
    });
    input.journal.replyDelivered(input.turnId);
    await input.journal.flush();
  }
  log.warn('auto', 'promise-correct-failed', {
    err: error instanceof Error ? error.message : String(error),
  });
}

async function stageFailedPromiseCorrection(input: {
  journal: TurnJournal;
  turnId: string;
  reply: NonNullable<TurnJournalEntry['reply']>;
  correctedBody: string;
  interactive: boolean;
  previousMessageId?: string;
}): Promise<void> {
  const supersedes = !input.interactive && input.previousMessageId
    ? input.previousMessageId
    : undefined;
  input.journal.stageReply(input.turnId, {
    markdown: input.correctedBody,
    replyTo: input.reply.replyTo,
    ...(input.reply.replyInThread ? { replyInThread: true } : {}),
    ...(input.reply.threadId ? { threadId: input.reply.threadId } : {}),
    replyMode: input.reply.replyMode,
    deliveryId: promiseCorrectionDeliveryKey(input.turnId),
    ...(input.interactive && input.previousMessageId
      ? { messageId: input.previousMessageId, interactive: true }
      : {}),
    ...(supersedes ? { supersedes } : {}),
  });
  if (supersedes) input.journal.noteNonAnswerId(input.turnId, supersedes);
  input.journal.clearCliAlreadySent(input.turnId);
  await input.journal.flush();
}

type SupersedeRecall = 'done' | 'retry';

/**
 * Recall a promise the correction replaced.
 * Success, or an already recalled / deleted / not-found message, is done.
 * A link or local failure stays retryable and does not fail the turn or recovery:
 * the staged correction already holds the new receipt, so a later pass recalls
 * this id and does not send the correction again.
 * A permanent rejection settles that correction after one log.
 * Not-in-chat is rethrown so the caller can run the existing chat cleanup.
 */
async function recallReplacedMessage(channel: LarkChannel, messageId: string): Promise<SupersedeRecall> {
  try {
    await channel.recallMessage(messageId);
    return 'done';
  } catch (error) {
    if (isSupersededMessageGone(error)) return 'done';
    log.warn('auto', 'promise-recall-failed', {
      err: error instanceof Error ? error.message : String(error),
    });
    if (isNotInChat(error)) throw error;
    const kind = classify(error);
    switch (kind) {
      case 'link':
      case 'local':
        return 'retry';
      case 'rejected':
        return 'done';
      default: {
        const _exhaustive: never = kind;
        throw _exhaustive;
      }
    }
  }
}

async function settleStreamDelivery(input: {
  stream: StreamDelivery;
  channel: LarkChannel;
  body: string;
  send: () => Promise<{ messageId?: string } | undefined>;
  fallback?: () => Promise<{ messageId?: string } | undefined>;
  journal?: TurnJournal;
  turnId?: string;
  replyMode: ReturnType<typeof getMessageReplyMode>;
  dedicatedFinal: boolean;
}): Promise<OutboundSettle> {
  switch (input.stream.kind) {
    case 'confirmed':
      if (input.stream.messageId && input.journal && input.turnId) {
        if (input.dedicatedFinal) {
          input.journal.noteNonAnswerId(input.turnId, input.stream.messageId);
        } else {
          input.journal.noteReplyReceipt(input.turnId, input.stream.messageId, true);
        }
        if (input.dedicatedFinal) await input.journal.flush();
      }
      return input.dedicatedFinal ? sendOrWait(input) : { kind: 'done' };
    case 'none':
      return sendOrWait(input);
    case 'failed':
      log.fail('stream', input.stream.err, { mode: input.replyMode, step: 'final-patch' });
      if (input.stream.messageId && input.journal && input.turnId) {
        if (input.dedicatedFinal) {
          input.journal.noteNonAnswerId(input.turnId, input.stream.messageId);
        } else {
          input.journal.noteReplyReceipt(input.turnId, input.stream.messageId, true);
        }
        await input.journal.flush();
      }
      if (input.dedicatedFinal) return sendOrWait(input);
      if (input.stream.messageId) return { kind: 'wait', error: input.stream.err };
      {
        const kind = classify(input.stream.err);
        switch (kind) {
          case 'link':
            return { kind: 'wait', error: input.stream.err };
          case 'rejected':
          case 'local':
            return sendOrWait(input);
          default: {
            const _exhaustive: never = kind;
            throw _exhaustive;
          }
        }
      }
    default: {
      const _exhaustive: never = input.stream;
      throw _exhaustive;
    }
  }
}

async function sendOrWait(input: {
  send: () => Promise<{ messageId?: string } | undefined>;
  fallback?: () => Promise<{ messageId?: string } | undefined>;
  journal?: TurnJournal;
  turnId?: string;
  replyMode: ReturnType<typeof getMessageReplyMode>;
}): Promise<OutboundSettle> {
  try {
    return await recordSend(input);
  } catch (err) {
    log.fail('outbound', err, { mode: input.replyMode, step: 'final-send' });
    const kind = classify(err);
    switch (kind) {
      case 'link':
        return { kind: 'wait', error: err };
      case 'rejected': {
        if (isNotInChat(err)) {
          if (input.journal && input.turnId) input.journal.replyRejected(input.turnId);
          throw err;
        }
        if (!input.fallback) {
          if (input.journal && input.turnId) input.journal.replyRejected(input.turnId);
          return { kind: 'done' };
        }
        try {
          return await recordSend({ ...input, send: input.fallback });
        } catch (retryErr) {
          log.fail('outbound', retryErr, { mode: input.replyMode, step: 'final-send' });
          if (classify(retryErr) === 'link') return { kind: 'wait', error: retryErr };
          if (input.journal && input.turnId) input.journal.replyRejected(input.turnId);
          if (isNotInChat(retryErr)) throw retryErr;
          return { kind: 'done' };
        }
      }
      case 'local':
        try {
          return await recordSend(input);
        } catch (retryErr) {
          log.fail('outbound', retryErr, { mode: input.replyMode, step: 'final-send' });
          return { kind: 'wait', error: retryErr };
        }
      default: {
        const _exhaustive: never = kind;
        throw _exhaustive;
      }
    }
  }
}

async function recordSend(input: {
  send: () => Promise<{ messageId?: string } | undefined>;
  journal?: TurnJournal;
  turnId?: string;
  replyMode: ReturnType<typeof getMessageReplyMode>;
}): Promise<{ kind: 'done' }> {
  const sent = await input.send();
  if (input.journal && input.turnId && sent?.messageId) {
    input.journal.noteReplyReceipt(input.turnId, sent.messageId, input.replyMode === 'card');
  }
  return { kind: 'done' };
}

async function resendJournalReply(input: {
  channel: LarkChannel;
  journal: TurnJournal;
  entry: TurnJournalEntry;
  botAppId: string;
  now?: () => number;
  onNotInChat?: (chatId: string) => void | Promise<unknown>;
}): Promise<boolean> {
  const { entry } = input;
  if (entry.cliAlreadySent) {
    log.info('outbound', 'skip-cli-already-sent', {
      scope: entry.scope,
      chatId: entry.chatId,
      mode: 'journal-resend',
    });
    return true;
  }
  const reply = entry.reply;
  if (!reply?.markdown.trim()) return false;
  let delivered = false;
  let messageId: string | undefined;
  const settled = await sendOrWait({
    send: async () => {
      const result = await redeliverStagedReply({
        channel: input.channel,
        entry,
        botAppId: input.botAppId,
        ...(input.now ? { now: input.now } : {}),
      });
      delivered = result.delivered;
      messageId = result.messageId;
      if (!result.delivered) return undefined;
      return result.messageId ? { messageId: result.messageId } : {};
    },
    fallback: async () => {
      const sent = await sendPlainTextReply({
        channel: input.channel,
        chatId: entry.chatId,
        body: reply.markdown,
        sendOpts: {
          replyTo: reply.replyTo,
          ...(reply.replyInThread ? { replyInThread: true } : {}),
        },
        deliveryId: reply.deliveryId,
      });
      delivered = Boolean(sent?.messageId);
      messageId = sent?.messageId;
      return sent;
    },
    journal: input.journal,
    turnId: entry.turnId,
    replyMode: journalReplyMode(reply.replyMode),
  });
  if (settled.kind === 'wait') {
    if (settled.error !== undefined) throw settled.error;
    return false;
  }
  if (!delivered) return false;
  const superseded = reply.supersedes?.trim();
  if (superseded && messageId !== superseded) {
    if (input.journal) await input.journal.flush();
    let recall: SupersedeRecall;
    try {
      recall = await recallReplacedMessage(input.channel, superseded);
    } catch (error) {
      if (!isNotInChat(error)) throw error;
      input.journal.replyRejected(entry.turnId);
      await input.journal.flush();
      await input.onNotInChat?.(entry.chatId);
      throw error;
    }
    switch (recall) {
      case 'done':
        break;
      case 'retry':
        return false;
      default: {
        const _exhaustive: never = recall;
        throw _exhaustive;
      }
    }
  }
  log.info('outbound', 'journal-resend', {
    scope: entry.scope,
    turnId: entry.turnId,
    chatId: entry.chatId,
    messageId,
  });
  return true;
}

function journalReplyMode(mode: string | undefined): ReturnType<typeof getMessageReplyMode> {
  switch (mode) {
    case 'card':
    case 'markdown':
    case 'text':
      return mode;
    default:
      return 'text';
  }
}

function stagedOutboxCount(journal: TurnJournal): number {
  let count = 0;
  for (const entry of journal.list()) {
    if (replyState(entry) === 'staged') count += 1;
    if (noticeState(entry) === 'staged') count += 1;
  }
  return count;
}

async function sendFinalReply(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  state: RunState;
  replyMode: ReturnType<typeof getMessageReplyMode>;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  cardRenderOptions: { signCallback?: (action: string) => string };
  turnId?: string;
  deliveryId?: string;
}): Promise<{ messageId?: string } | undefined> {
  const body = renderText(input.state);

  // Nothing deliverable to send (agent produced no text on a clean finish;
  // error/interrupt/timeout keep `body` non-empty via their notices). Skip
  // rather than post an empty card that renders as "(no content)".
  if (!body.trim()) {
    log.info('outbound', 'skip-empty', { scope: input.scope, mode: input.replyMode });
    return undefined;
  }

  const sendOpts = withDeliveryUuid(
    input.sendOpts,
    input.deliveryId ?? (input.turnId ? replyDeliveryKey(input.turnId) : undefined),
  );

  if (input.replyMode === 'card') {
    const result = await input.channel.send(
      input.chatId,
      { card: renderCard(input.state, input.cardRenderOptions) },
      sendOpts,
    );
    requireMessageReceipt(result, 'card');
    log.info('outbound', 'sent', outboundLogFields(input, 'card', body, result));
    return result;
  }
  if (input.replyMode === 'markdown') {
    const result = await input.channel.send(
      input.chatId,
      { markdown: body },
      sendOpts,
    );
    requireMessageReceipt(result, 'markdown');
    log.info('outbound', 'sent', outboundLogFields(input, 'markdown', body, result));
    return result;
  }
  const result = await input.channel.send(
    input.chatId,
    { markdown: body },
    sendOpts,
  );
  requireMessageReceipt(result, 'text');
  log.info('outbound', 'sent', outboundLogFields(input, 'text', body, result));
  return result;
}

function requireMessageReceipt(result: { messageId?: string }, type: string): void {
  if (!result.messageId?.trim()) {
    throw new Error(`final ${type} reply missing message receipt`);
  }
}

async function sendPlainTextReply(input: {
  channel: LarkChannel;
  chatId: string;
  body: string;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  deliveryId?: string;
}): Promise<{ messageId?: string } | undefined> {
  if (!input.body.trim()) return undefined;
  const replyTo = input.sendOpts.replyTo.trim();
  const result = await input.channel.send(
    input.chatId,
    { text: input.body },
    withDeliveryUuid({
      ...(replyTo ? { replyTo } : {}),
      ...(input.sendOpts.replyInThread ? { replyInThread: true } : {}),
    }, input.deliveryId),
  );
  requireMessageReceipt(result, 'text');
  return result;
}

async function sendCotDegradedNotice(input: {
  channel: LarkChannel;
  chatId: string;
  scope: string;
  sendOpts: { replyTo: string; replyInThread?: boolean };
  reason: string;
  journal?: TurnJournal;
  turnId?: string;
}): Promise<void> {
  log.warn('cot', 'degraded', {
    scope: input.scope,
    reason: input.reason,
    replyInThread: input.sendOpts.replyInThread === true,
  });
  try {
    const result = await input.channel.send(
      input.chatId,
      { markdown: 'COT 过程消息更新失败，已停止展示过程；最终答案仍会继续发送。' },
      input.sendOpts,
    );
    const messageId = outboundMessageId(result);
    if (messageId && input.journal && input.turnId) {
      input.journal.noteNonAnswerId(input.turnId, messageId);
    }
  } catch (err) {
    log.warn('cot', 'degraded-notice-failed', {
      scope: input.scope,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function outboundLogFields(
  input: {
    scope?: string;
    replyMode: ReturnType<typeof getMessageReplyMode>;
    sendOpts?: { replyTo?: string; replyInThread?: boolean };
  },
  type: string,
  body: string,
  result?: { messageId?: string },
): Record<string, unknown> {
  return {
    type,
    scope: input.scope,
    mode: input.replyMode,
    chars: body.length,
    messageId: result?.messageId,
    replyTo: input.sendOpts?.replyTo,
    replyInThread: input.sendOpts?.replyInThread === true,
  };
}

/**
 * Drive the agent's event stream into a stateful RunState, calling `flush`
 * on every state transition. Used by both card and markdown reply modes —
 * the only difference between the two is what `flush` does with the state.
 */
async function processAgentStream(
  handle: RunHandle,
  events: AsyncIterable<AgentEvent>,
  scope: string,
  idleTimeoutMs: number | undefined,
  recordSession: (event: AgentEvent) => void,
  flush: (state: RunState) => Promise<void>,
  runContext?: { currentChatId: string; batchMessageIds: readonly string[] },
  reliability: StreamReliability = {},
): Promise<RunState> {
  const signatures = reliability.signatures;
  const runStart = Date.now();
  let state: RunState = seedRunState(runContext ?? {});
  let lastTerminal: AgentEvent | undefined;

  // Idle watchdog: silence for `idleTimeoutMs` is treated as "presumed hung".
  // An open tool call pauses that bound (a long `lark-cli` OAuth can be
  // quiet for a while) but the pause itself is capped at 60 minutes.
  // Shared with agent-task fires via createIdleWatchdog.
  const watchdog = createIdleWatchdog({ handle, idleTimeoutMs, scope });

  try {
    for await (const evt of events) {
      noteRunEvent(handle);
      // A stopped run can still deliver its final resume handle before cleanup.
      // Keep draining owned events while suppressing further UI updates.
      if (evt.type === 'system') {
        if (!handle.interrupted) watchdog.arm();
        recordSession(evt);
        continue;
      }
      if (!shouldDeliverAgentEvent(handle, evt)) continue;

      // Track tool flight before re-arming the idle timer so the arm step
      // sees the correct set size. tool_use opens a window; tool_result
      // closes it. Other event types are bookkept after the if/else.
      watchdog.noteDelivered(evt);

      if (evt.type === 'usage') {
        const { costUsd, inputTokens, outputTokens } = evt;
        if (costUsd !== undefined || inputTokens !== undefined || outputTokens !== undefined) {
          log.info('agent', 'usage', {
            ...(costUsd !== undefined ? { costUsd: Number(costUsd.toFixed(4)) } : {}),
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          });
          if (costUsd !== undefined) reportMetric('cost_usd', costUsd);
          if (inputTokens !== undefined) reportMetric('tokens_in', inputTokens);
          if (outputTokens !== undefined) reportMetric('tokens_out', outputTokens);
        }
        continue;
      }

      if (evt.type === 'done' || evt.type === 'error') {
        lastTerminal = evt;
        noteTerminalStop(handle, evt);
      }

      const prevTerminal = state.terminal;
      const prevFooter = state.footer;
      state = reduce(state, evt);
      if (evt.type === 'error' && state.terminal === 'error') {
        const stderrTail = handle.run.stderrSnapshot ?? evt.message;
        const matched = matchCliSignature(stderrTail, signatures);
        const early = deriveRunOutcome({
          stopRequest: handle.stopRequest,
          terminalEvent: evt,
          stderrTail,
          signatures,
          exit: handle.run.exit,
          signal: handle.run.signal,
          outageOverlapped: reliability.outageOverlapped?.(),
        });
        const msg = cardUserMessage(early, matched);
        if (msg) state = { ...state, errorMsg: msg };
      }
      if (state.footer !== prevFooter || state.terminal !== prevTerminal) {
        log.info('card', 'transition', { footer: state.footer, terminal: state.terminal });
      }
      await flush(state);
      // Stop iterating as soon as we have a terminal state. Some claude
      // versions don't close stdout immediately after the result event, which
      // would leave the for-await waiting forever otherwise.
      if (state.terminal !== 'running') break;
    }
  } finally {
    watchdog.dispose();
  }

  // If state already reached a terminal event (done/error/etc.) before the
  // watchdog or interrupt could land, don't clobber it — that real terminal
  // wins. This avoids "claude finished but flush was slow → timer fired
  // mid-flush → user sees 'idle_timeout' on a successful run".
  const stderrTail = handle.run.stderrSnapshot
    ?? (lastTerminal?.type === 'error' ? lastTerminal.message : undefined);
  const matched = matchCliSignature(stderrTail, signatures);
  const outcome = deriveRunOutcome({
    stopRequest: handle.stopRequest,
    terminalEvent: lastTerminal,
    stderrTail,
    signatures,
    exit: handle.run.exit,
    signal: handle.run.signal,
    outageOverlapped: reliability.outageOverlapped?.(),
  });
  noteUnclassifiedStderr({
    outcome,
    stderrTail,
    signature: matched,
    agent: reliability.agent,
  });
  const userMessage = cardUserMessage(outcome, matched);
  if (
    state.terminal === 'running'
    || cardTerminalFromOutcome(outcome) !== state.terminal
    || userMessage !== undefined
  ) {
    state = applyOutcomeToState(state, outcome, watchdog.armedDelayMs(), userMessage);
  }
  if (userMessage !== undefined && state.terminal === 'error') {
    state = { ...state, errorMsg: userMessage };
  }
  handle.outcome = outcome;
  log.info('card', 'final', {
    scope,
    terminal: state.terminal,
    stopReason: handle.stopRequest ? formatStopRequest(handle.stopRequest) : undefined,
    outcome: formatRunOutcome(outcome),
    interrupted: handle.interrupted,
  });
  reportMetric('run_e2e_ms', Date.now() - runStart, { terminal: state.terminal });
  await flush(state);
  if (handle.interrupted) {
    await handle.run.stop();
  }
  return state;
}

function applyOutcomeToState(
  state: RunState,
  outcome: ReturnType<typeof deriveRunOutcome>,
  idleTimeoutMs: number | undefined,
  userMessage?: string,
): RunState {
  const terminal = cardTerminalFromOutcome(outcome);
  switch (terminal) {
    case 'idle_timeout':
      return markIdleTimeout(state, Math.round((idleTimeoutMs ?? 0) / 60_000));
    case 'runner_timeout':
      return markRunnerTimeout(state);
    case 'interrupted':
      return markInterrupted(state);
    case 'error':
      return {
        ...state,
        terminal: 'error',
        footer: null,
        ...(userMessage !== undefined ? { errorMsg: userMessage } : {}),
      };
    case 'done':
      return appendOutcomeNotice(finalizeIfRunning(state), userMessage);
    case 'running':
      return state;
    default: {
      const _exhaustive: never = terminal;
      return _exhaustive;
    }
  }
}

interface StreamReliability {
  signatures?: readonly CliSignature[];
  agent?: string;
  outageOverlapped?: () => boolean;
}

function streamReliability(
  profile: { agentKind: string },
  getLink?: () => { outageEpoch(): number; isDown(): boolean } | undefined,
): StreamReliability {
  const kind = profile.agentKind;
  const link = getLink?.();
  const startedEpoch = link?.outageEpoch() ?? 0;
  const startedDown = link?.isDown() ?? false;
  return {
    signatures: [
      ...(isAgentKind(kind) ? descriptorFor(kind).stderrSignatures : []),
      ...NETWORK_TRANSIENT_SIGNATURES,
    ],
    agent: kind,
    outageOverlapped: () => runOverlappedOutage(getLink?.(), startedEpoch, startedDown),
  };
}

async function awaitRenderAwareStream(input: {
  mode: 'card' | 'markdown';
  progress: LazyProgressStream;
  renderDone: Promise<RunState>;
  producerStarted: () => boolean;
  producerRendered: () => boolean;
  timeoutMs: number;
}): Promise<StreamDelivery> {
  const streamResult = input.progress.settled.then(
    (result) => ({ kind: 'stream' as const, ok: true as const, result }),
    (err) => ({ kind: 'stream' as const, ok: false as const, err }),
  );
  const renderResult = input.renderDone.then(
    (state) => ({ kind: 'render' as const, ok: true as const, state }),
    (err) => ({ kind: 'render' as const, ok: false as const, err }),
  );
  const first = await Promise.race([streamResult, renderResult]);
  if (!first.ok) {
    if (first.kind === 'stream') {
      const rendered = await renderResult;
      if (!rendered.ok) throw rendered.err;
      if (!input.producerRendered()) input.progress.abandon();
      return failedStream(first.err, input.progress);
    }
    throw first.err;
  }

  if (first.kind === 'stream') {
    const rendered = await renderResult;
    if (!rendered.ok) throw rendered.err;
    return confirmedStream(first.result, input.progress);
  }

  // Nothing durable ever showed up, so no progress message was opened at all
  // (the common Codex final-only round). Whatever the run ended with still has
  // to reach the user as a standalone reply.
  if (!input.progress.opened()) {
    log.info('outbound', 'progress-stream-skipped', { mode: input.mode });
    return { kind: 'none' };
  }

  // The run ended before the stream did. A producer that hasn't started yet is
  // usually just a card still being created (two API round trips), so give the
  // stream its grace window rather than replying immediately — an immediate
  // send would post the same answer twice once the stream catches up.
  const terminal = await Promise.race([
    streamResult,
    delay(STREAM_TERMINAL_GRACE_MS).then(() => undefined),
  ]);

  if (!terminal) {
    if (input.producerStarted()) {
      log.warn('stream', 'terminal-grace-expired', {
        mode: input.mode,
        graceMs: STREAM_TERMINAL_GRACE_MS,
      });
      try {
        const waited = await withOutboundTimeout('stream.producer', streamResult, input.timeoutMs);
        if (!waited.ok) return failedStream(waited.err, input.progress);
        return confirmedStream(waited.result, input.progress);
      } catch (err) {
        return failedStream(err, input.progress);
      }
    }
    // Still nothing on screen after the grace window: give up on the stream and
    // reply without it. `abandon()` keeps a late producer from rendering the
    // same answer again; the empty message it leaves is recalled in cleanup.
    input.progress.abandon();
    log.warn('stream', 'producer-not-started-before-agent-terminal', { mode: input.mode });
    return { kind: 'none' };
  }

  if (!terminal.ok) {
    if (!input.producerRendered()) input.progress.abandon();
    return failedStream(terminal.err, input.progress);
  }
  return confirmedStream(terminal.result, input.progress);
}

function confirmedStream(result: unknown, progress: LazyProgressStream): StreamDelivery {
  const messageId = outboundMessageId(result) ?? progress.messageId() ?? '';
  if (messageId) progress.noteMessageId(messageId);
  return { kind: 'confirmed', messageId };
}

function failedStream(err: unknown, progress: LazyProgressStream): StreamDelivery {
  const messageId = progress.messageId();
  return messageId ? { kind: 'failed', err, messageId } : { kind: 'failed', err };
}

function scheduleWorkingReactionCleanup(
  channel: LarkChannel,
  messageId: string,
  reactionPromise: Promise<string | undefined> | undefined,
): void {
  if (!reactionPromise) return;

  void (async () => {
    const reactionResult = reactionPromise.then(
      (reactionId) => ({ ok: true as const, reactionId }),
      (err) => ({ ok: false as const, err }),
    );
    const settled = await Promise.race([
      reactionResult,
      delay(REACTION_CLEANUP_GRACE_MS).then(() => undefined),
    ]);

    if (!settled) {
      log.warn('reaction', 'cleanup-deferred', {
        messageId,
        graceMs: REACTION_CLEANUP_GRACE_MS,
      });
      void reactionResult.then((result) => {
        if (!result.ok || !result.reactionId) return;
        void removeReaction(channel, messageId, result.reactionId);
      });
      return;
    }

    if (!settled.ok || !settled.reactionId) return;
    await removeReaction(channel, messageId, settled.reactionId);
  })();
}

function applyTakenInstruction(taken: ContinuationTaken, extraInstructions: string[]): void {
  switch (taken.kind) {
    case 'none':
      return;
    case 'continue':
    case 'abandoned':
      extraInstructions.push(taken.instruction);
      return;
    default: {
      const _exhaustive: never = taken;
      return _exhaustive;
    }
  }
}

function journalResources(batch: NormalizedMessage[]): { resources: TurnJournalResource[] } | Record<string, never> {
  const resources: TurnJournalResource[] = [];
  for (const msg of batch) {
    for (const item of msg.resources) {
      if (!isJournalResourceType(item.type) || typeof item.fileKey !== 'string') continue;
      resources.push({
        type: item.type,
        fileKey: item.fileKey,
        sourceMessageId: msg.messageId,
      });
    }
  }
  return resources.length > 0 ? { resources } : {};
}

function journalResourcesToMessage(
  resources: TurnJournalResource[] | undefined,
): NormalizedMessage['resources'] {
  if (!resources?.length) return [];
  return resources.map((item) => ({
    type: item.type,
    fileKey: item.fileKey,
    sourceMessageId: item.sourceMessageId,
  })) as NormalizedMessage['resources'];
}

function journalResourceSourceId(resource: unknown): string | undefined {
  if (!resource || typeof resource !== 'object') return undefined;
  const sourceMessageId = (resource as { sourceMessageId?: unknown }).sourceMessageId;
  return typeof sourceMessageId === 'string' && sourceMessageId
    ? sourceMessageId
    : undefined;
}

function noticeArgs(input: {
  journal: TurnJournal;
  turnId: string;
  scope: string;
  outcome: RunOutcome;
  notice: {
    auth?: NoticeActionAuth;
    continuations: Continuations;
    ownerId?: string;
    requireBotMention: boolean;
  };
}) {
  const plan = planInterruptionNotice(input.outcome);
  if (plan.kind === 'continue') input.notice.continuations.offer(input.turnId, input.outcome);
  return {
    journal: input.journal,
    turnId: input.turnId,
    outcome: input.outcome,
    noticeAuth: input.notice.auth,
    consecutive: input.notice.continuations.consecutive(input.scope),
    requireBotMention: input.notice.requireBotMention,
    ownerId: input.notice.ownerId,
    authNotified: authNoticeAlreadyDelivered(input.journal),
  };
}

function stageTurnNotice(input: {
  journal: TurnJournal;
  turnId: string;
  scope: string;
  outcome: RunOutcome;
  notice: {
    auth?: NoticeActionAuth;
    continuations: Continuations;
    ownerId?: string;
    requireBotMention: boolean;
  };
}): void {
  if (planInterruptionNotice(input.outcome).kind === 'none') return;
  stageInterruptionNotice(noticeArgs(input));
}

async function sendTurnNotice(input: {
  channel: LarkChannel;
  journal: TurnJournal;
  turnId: string;
  scope: string;
  outcome: RunOutcome;
  notice: {
    auth?: NoticeActionAuth;
    continuations: Continuations;
    ownerId?: string;
    requireBotMention: boolean;
  };
  link?: { isDown(): boolean };
  onWait?: (delayMs?: number) => void;
}): Promise<void> {
  if (planInterruptionNotice(input.outcome).kind === 'none') return;
  if (input.link?.isDown()) return;
  const result = await deliverInterruptionNotice({
    send: (chatId, content, options) => input.channel.send(chatId, content, options),
    ...noticeArgs(input),
  });
  if (!result.delivered) input.onWait?.();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function consumeBackfillMarks(
  batch: NormalizedMessage[],
  marks: Map<string, BackfillMark>,
): NormalizedMessage[] {
  const marked: NormalizedMessage[] = [];
  for (const msg of batch) {
    if (!marks.has(msg.messageId)) continue;
    marks.delete(msg.messageId);
    marked.push(msg);
  }
  return marked;
}

function buildPrompt(
  batch: NormalizedMessage[],
  attachments: LocalAttachment[],
  quotes: QuotedContext[] = [],
  topicContext: QuotedContext[] = [],
  botIdentity?: { openId: string; name?: string },
  extraInstructions?: string[],
): string {
  const first = batch[0];
  if (!first) return '';

  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  // When the debounce window merged messages (possibly from several senders —
  // common in bot-at-bot group chats), annotate each segment with its sender
  // so the agent can tell who said what. Single-message batches stay verbatim.
  const annotate = batch.length > 1;
  const texts = batch
    .map((m) => {
      const text = stripAttachmentRefs(m.content, fileKeys).trim();
      if (!text) return '';
      return annotate ? `${senderAnnotation(m)} ${text}` : text;
    })
    .filter(Boolean);
  const userPart =
    texts.length > 0
      ? texts.join('\n\n')
      : attachments.length > 0
        ? '请看下面的附件。'
        : '（对方发来一条没有正文的消息——通常是只 @ 了你的唤醒（ping）。请简短回应。）';

  const senderType = senderTypeOf(first);
  const mentions = mergeMentions(batch);

  return buildAgentPrompt({
    context: {
      chatId: first.chatId,
      chatType: first.chatType,
      senderId: first.senderId,
      ...(first.senderName ? { senderName: first.senderName } : {}),
      ...(senderType ? { senderType } : {}),
      ...(botIdentity?.openId ? { botOpenId: botIdentity.openId } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(first.threadId ? { threadId: first.threadId } : {}),
      messageIds: batch.map((m) => m.messageId),
      source: 'im',
    },
    instructions:
      extraInstructions && extraInstructions.length > 0
        ? [...BRIDGE_AGENT_INSTRUCTIONS, ...extraInstructions]
        : BRIDGE_AGENT_INSTRUCTIONS,
    userInput: userPart,
    ...(topicContext.length > 0 ? { topicContext: topicContext.map(toPromptTopicMessage) } : {}),
    quotedMessages: quotes.map(toPromptQuote),
    interactiveCards: batch.map(toPromptInteractiveCard).filter(isDefined),
    attachments: attachments.map(toPromptAttachment),
  });
}

/**
 * Classify the sender as human or bot from the raw Feishu event
 * (`sender.sender_type`: 'user' = human, 'app' = bot). The normalizer drops
 * this field, so read it off `msg.raw` (`includeRawEvent: true` above).
 * Unknown / missing values return undefined — omit rather than guess.
 */
function dropInboundSelfMessage(input: {
  msg: NormalizedMessage;
  botOpenId?: string;
  botAppId?: string;
  outbound: OutboundMessageIds;
  tracker: CliSelfSendTracker;
  journal?: TurnJournal;
}): boolean {
  const dropped = noteInboundSkipSelf({
    messageId: input.msg.messageId,
    chatId: input.msg.chatId,
    threadId: input.msg.threadId,
    isSelf: isSelfSender({
      senderId: input.msg.senderId,
      senderType: senderTypeFromRaw((input.msg as { raw?: unknown }).raw),
      chatType: input.msg.chatType,
      botOpenId: input.botOpenId,
      botAppId: input.botAppId,
    }),
    outbound: input.outbound,
    tracker: input.tracker,
  });
  if (!dropped) return false;
  const scope = input.msg.threadId
    ? `${input.msg.chatId}:${input.msg.threadId}`
    : input.msg.chatId;
  const cliSelfSend = input.tracker.has(scope) || input.tracker.has(input.msg.chatId);
  const turnId = input.tracker.turnIdFor(scope) ?? input.tracker.turnIdFor(input.msg.chatId);
  if (cliSelfSend && turnId) input.journal?.noteCliAlreadySentForScope(scope, turnId);
  log.info('intake', 'skip-self', {
    msgId: input.msg.messageId,
    chatId: input.msg.chatId,
    ...(cliSelfSend ? { reason: 'cli-self-send' } : {}),
  });
  return true;
}

function senderTypeOf(msg: NormalizedMessage): 'user' | 'bot' | undefined {
  const raw = msg.raw as { sender?: { sender_type?: unknown } } | undefined;
  const senderType = raw?.sender?.sender_type;
  if (senderType === 'user') return 'user';
  if (senderType === 'app' || senderType === 'bot') return 'bot';
  return undefined;
}

function senderAnnotation(msg: NormalizedMessage): string {
  const name = msg.senderName ?? msg.senderId;
  const type = senderTypeOf(msg);
  return type ? `[${name} (${type})]:` : `[${name}]:`;
}

function mergeMentions(batch: NormalizedMessage[]): BridgePromptMention[] {
  const seen = new Set<string>();
  const out: BridgePromptMention[] = [];
  for (const msg of batch) {
    for (const mention of msg.mentions ?? []) {
      const dedupeKey = mention.openId ?? `${mention.name ?? ''}:${mention.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        ...(mention.openId ? { openId: mention.openId } : {}),
        ...(mention.name ? { name: mention.name } : {}),
        ...(mention.isBot !== undefined ? { isBot: mention.isBot } : {}),
      });
    }
  }
  return out;
}

function replyQuoteTargetForMessage(
  msg: NormalizedMessage,
  mode: ChatMode,
): string | undefined {
  const replyTo = msg.replyToMessageId;
  if (!replyTo) return undefined;

  // Feishu topic messages use root_id/parent_id as the topic root anchor even
  // for ordinary in-topic messages. Treat that as structure, not a quote.
  if (mode === 'topic' && msg.threadId && msg.rootId && replyTo === msg.rootId) {
    return undefined;
  }
  return replyTo;
}

function stripAttachmentRefs(text: string, fileKeys: string[]): string {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
    out = out.replace(
      new RegExp(
        `<\\s*(?:file|image|img|audio|video|media|folder)\\b[^>]*\\bkey\\s*=\\s*["']${escaped}["'][^>]*>`,
        'gi',
      ),
      '',
    );
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

function toPromptQuote(q: QuotedContext): BridgePromptQuotedMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptTopicMessage(q: QuotedContext): BridgePromptTopicMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.senderType ? { senderType: q.senderType } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptInteractiveCard(m: NormalizedMessage): BridgePromptInteractiveCard | undefined {
  if (m.rawContentType !== 'interactive') return undefined;
  const rawContent = (m.raw as { message?: { content?: unknown } } | undefined)
    ?.message?.content;
  if (typeof rawContent !== 'string' || rawContent.length === 0) return undefined;
  return {
    messageId: m.messageId,
    content: parseJsonOrRaw(rawContent),
  };
}

function parseJsonOrRaw(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
