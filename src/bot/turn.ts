import type { LarkChannel } from '@larksuite/channel';
import type { AgentEvent, AgentPromptVariant } from '../agent/types';
import { descriptorFor, isAgentKind } from '../agent/registry';
import { cardUserMessage, cliFailureInput, matchCliSignature, NETWORK_TRANSIENT_SIGNATURES, noteUnclassifiedStderr, type CliSignature } from '../agent/cli-signatures';
import { renderCard } from '../card/run-renderer';
import { renderText } from '../card/text-renderer';
import { finalizeIfRunning, initialState, markIdleTimeout, markInterrupted, markRunnerTimeout, reduce, seedRunState, shouldSkipFinalReply, type RunState } from '../card/run-state';
import { log, reportMetric } from '../core/logger';
import type { MessageReplyMode, CotMessagesMode } from '../config/schema';
import type { CallbackAuth } from '../card/callback-auth';
import { noteRunEvent, type RunHandle } from './active-runs';
import { createIdleWatchdog } from './idle-watchdog';
import { cardTerminalFromOutcome, formatRunOutcome, formatStopRequest, noteTerminalStop, requestStop, shouldDeliverAgentEvent, type RunOutcome, type StopRequest } from './run-outcome';
import { recordRunSessionEvent, startRunFlow, type StartRunFlowInput, type StartRunFlowResult } from './run-flow';
import { Outbox, type StreamDelivery } from './outbox';
import type { TurnJournal } from './turn-journal';
import { outboundMessageId, withOutboundTimeout, type CliSelfSendTracker } from './self-message';
import { addWorkingReaction, removeReaction } from './reaction';
import { consumeCotEvents, CotClient, CotPublisher, appendOutcomeNotice, finalAnswerOnlyState, finalReplyFor } from './cot';

const STREAM_TERMINAL_GRACE_MS = 3000;
const REACTION_CLEANUP_GRACE_MS = 1000;
type StartedFlow = Extract<StartRunFlowResult, { ok: true }>;
type FinalDelivery = Parameters<Outbox['deliverFinalReply']>[0];

interface TurnTarget {
  outbox: Outbox;
  journal?: TurnJournal;
  turnId?: string;
  chatId: string;
}

export interface ChatTurnDelivery extends TurnTarget {
  kind: 'chat';
  channel: LarkChannel;
  sendOpts: FinalDelivery['sendOpts'];
  replyMode: MessageReplyMode;
  filterState(state: RunState): RunState;
  batchMessageIds?: readonly string[];
  callbackAuth?: CallbackAuth;
  activePolicyFingerprints?: Map<string, string>;
  canRecordSession?: () => boolean;
  requestedModel?: string;
  onRejected?: (reason: Extract<StartRunFlowResult, { ok: false }>['rejectReason']) => void;
  notice?: FinalDelivery['notice'];
  cliSelfSent?: CliSelfSendTracker;
  onWait?: FinalDelivery['onWait'];
  onNotInChat?: FinalDelivery['onNotInChat'];
  outboundTimeoutMs: number;
  cot?: { client: CotClient; detail: Exclude<CotMessagesMode, 'off'>; inputPreview: string };
}

export interface AutomationTurnDelivery extends TurnTarget {
  kind: 'automation';
  actor: string;
  emptyResult: string;
  failureBody(outcome: RunOutcome): string;
  formatPost(body: string, followUp: boolean): string;
  onSettled?: (outcome: RunOutcome) => void | Promise<void>;
  /** Execution status precedes delivery; a failed send must not undo a successful task. */
  onResult?: (ok: boolean) => void;
}

export interface TurnInput {
  run: Omit<StartRunFlowInput, 'onEvent'>;
  delivery: ChatTurnDelivery | AutomationTurnDelivery;
  idleTimeoutMs?: number;
  /** Synchronous, before the executor buffers events or settles its outcome. */
  onToolUse?: (event: Extract<AgentEvent, { type: 'tool_use' }>) => StopRequest | undefined;
}

export type TurnResult = Exclude<StartRunFlowResult, { ok: true }> | {
  ok: true;
  state: RunState;
  handle: RunHandle;
};

/** A launch error is distinct from event consumption or child settlement failure. */
export class TurnStartFailed extends Error {
  constructor(cause: unknown) { super('turn failed to start', { cause }); }
}

/** Runs prepared input through settlement and Outbox delivery for both callers. */
export async function executeTurn(input: TurnInput): Promise<TurnResult> {
  let flow: StartRunFlowResult;
  try {
    flow = await startRunFlow({ ...input.run, onEvent(event, handle) {
      if (handle.interrupted || event.type !== 'tool_use') return;
      const stop = input.onToolUse?.(event);
      if (!stop) return;
      requestStop(handle, stop);
      void handle.run.stop().catch(() => {});
    } });
  } catch (error) {
    throw new TurnStartFailed(error);
  }
  const { delivery, run } = input;
  if (!flow.ok) {
    if (delivery.kind === 'chat') {
      log.info('run-flow', 'rejected', { scope: run.scopeId, code: flow.rejectReason.code });
      log.warn('policy', 'denied', { scope: run.scopeId, source: 'im', code: flow.rejectReason.code });
      delivery.onRejected?.(flow.rejectReason);
      await delivery.channel.send(delivery.chatId, { markdown: flow.rejectReason.userVisible }, delivery.sendOpts);
      if (delivery.journal && delivery.turnId) delivery.journal.voidTurn(delivery.turnId);
    }
    return flow;
  }
  if (delivery.journal && delivery.turnId) delivery.journal.noteTurnMeta(delivery.turnId, {
    ...(flow.resumeFrom ? { resumeHandle: flow.resumeFrom } : {}),
    policyFingerprint: flow.policy.policyFingerprint,
  });
  const recordSession = (event: AgentEvent): void => {
    if (delivery.kind === 'chat' && delivery.canRecordSession?.() === false) return;
    recordRunSessionEvent({ ...run, policy: flow.policy, event });
    if (event.type === 'system' && event.resumeHandle) {
      if (delivery.journal && delivery.turnId) delivery.journal.noteTurnMeta(delivery.turnId, { resumeHandle: event.resumeHandle });
      if (delivery.kind === 'chat') log.info('session', 'set', { resumeHandle: event.resumeHandle });
    }
    if (delivery.kind === 'chat' && event.type === 'system' && event.model) log.info('session', 'model', {
      requested: delivery.requestedModel ?? 'default', actual: event.model,
    });
  };
  if (delivery.kind === 'automation') return deliverAutomationTurn(input, flow, delivery, recordSession);
  delivery.activePolicyFingerprints?.set(run.scopeId, flow.policy.policyFingerprint);
  try {
    const state = await deliverChatTurn(input, flow, delivery, recordSession);
    return { ok: true, state, handle: flow.execution.handle };
  } finally {
    delivery.activePolicyFingerprints?.delete(run.scopeId);
  }
}

async function deliverAutomationTurn(
  input: TurnInput,
  flow: StartedFlow,
  delivery: AutomationTurnDelivery,
  recordSession: (event: AgentEvent) => void,
): Promise<TurnResult> {
  const { run } = input;
  const { chatId, journal, turnId } = delivery;
  const scope = run.scopeId;
  const state = await processAgentStream(flow.execution.handle, flow.execution.subscribe(), scope,
    input.idleTimeoutMs, recordSession, async () => {}, { currentChatId: chatId, batchMessageIds: [] },
    { signatures: turnStderrSignatures(run.profileConfig.agentKind, 'automation'), agent: run.profileConfig.agentKind });
  const outcome = flow.execution.handle.outcome!;
  await delivery.onSettled?.(outcome);
  if (journal && turnId) journal.markSettled(turnId, outcome);
  if (shouldSkipFinalReply(state, chatId)) {
    if (journal && turnId) {
      journal.noteCliAlreadySent(turnId);
      journal.replyDelivered(turnId);
      await journal.flush();
    }
    log.info('outbound', 'skip-cli-already-sent', { scope, chatId, mode: 'text' });
    delivery.onResult?.(true);
    return { ok: true, state, handle: flow.execution.handle };
  }
  let body: string;
  let followUp = false;
  if (outcome.kind === 'interrupted' || outcome.kind === 'failed') {
    body = delivery.failureBody(outcome);
  } else {
    const replied = finalReplyFor(state, { replyMode: descriptorFor(run.profileConfig.agentKind).replyMode, streamed: false });
    body = renderText({ ...replied, blocks: replied.blocks.filter(block => block.kind !== 'tool') }).trim();
    if (!body && outcome.kind !== 'completed' && outcome.kind !== 'partial') {
      body = delivery.failureBody(outcome);
    } else {
      if (!body) body = delivery.emptyResult;
      followUp = true;
    }
  }
  delivery.onResult?.(followUp);
  if (journal && turnId) await delivery.outbox.deliverAutomation({
    kind: 'result', turnId, chatId, scope, actor: delivery.actor, markdown: delivery.formatPost(body, followUp),
  });
  return { ok: true, state, handle: flow.execution.handle };
}

async function deliverChatTurn(
  input: TurnInput,
  flow: StartedFlow,
  delivery: ChatTurnDelivery,
  recordSession: (event: AgentEvent) => void,
): Promise<RunState> {
  const { execution, cwdRealpath: cwd } = flow;
  const { outbox, channel, chatId, sendOpts, turnId, journal, callbackAuth, cliSelfSent,
    outboundTimeoutMs, notice: noticeCtx, onWait: onDeliveryWait } = delivery;
  const scope = input.run.scopeId;
  const handle = execution.handle;
  const eventStream = execution.subscribe();
  const idleTimeoutMs = input.idleTimeoutMs;
  const runContext = { currentChatId: chatId, batchMessageIds: delivery.batchMessageIds ?? [] };
  const reliability = streamReliability(input.run.profileConfig);
  const lastMsg = { messageId: sendOpts.replyTo, content: delivery.cot?.inputPreview ?? '' };
  log.info('session', flow.resumeFrom ? 'resume' : 'fresh', { ...(flow.resumeFrom ? { resumeHandle: flow.resumeFrom } : {}), cwd });
  const replyMode = delivery.replyMode;
  const finalAnswerOnly =
    descriptorFor(input.run.profileConfig.agentKind).replyMode === 'final-answer';
  log.info('flush', 'reply-mode', { mode: replyMode });
  const cotMessages = delivery.cot?.detail ?? 'off';
  const cotEnabled = cotMessages !== 'off';
  const filterForPrefs = delivery.filterState;
  const cardRenderOptions = callbackAuth
    ? {
        signCallback: (action: string) =>
          callbackAuth.sign({
            runId: execution.runId,
            scope,
            chatId,
            operatorOpenId: input.run.scope.actorId,
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

  const onNotInChat = delivery.onNotInChat;
  cliSelfSent?.begin(scope, turnId);
  try {
    if (cotEnabled) {
      const cotPublisher = new CotPublisher({
        client: delivery.cot!.client,
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
          detail: delivery.cot!.detail,
        });
        const finalState = await processAgentStream(
          handle,
          eventStream,
          scope,
          idleTimeoutMs,
          recordSession,
          async () => {},
          runContext,
          reliability,
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
        await outbox.deliverFinalReply({
          chatId,
          scope,
          state: finalAnswerOnlyState(finalState),
          skipFrom: finalState,
          replyMode,
          sendOpts,
          cardRenderOptions,
          turnId,
          outcome: handle.outcome,
          notice: noticeCtx,
          cliSelfSent,
          onWait: onDeliveryWait,
          onNotInChat,

        });
        return finalState;
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
        outbox.stream(
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
          sendOpts,
          turnId,
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
        reliability,
      );
      const stream = await awaitRenderAwareStream({
        mode: replyMode,
        progress,
        renderDone,
        producerStarted: () => producerStarted,
        producerRendered: () => producerRendered,
        timeoutMs: outboundTimeoutMs,
      });
      await outbox.recallEmptyStream(progress, filterForPrefs(latestState), scope);
      const visible = filterForPrefs(latestState);
      const terminalState = finalAnswerOnly
        ? finalReplyState(stream, visible)
        : finalReplyFor(visible, { replyMode: 'stream-deltas', streamed: false });
      await outbox.deliverFinalReply({
        chatId,
        scope,
        state: terminalState,
        skipFrom: latestState,
        stream,
        dedicatedFinal: finalAnswerOnly,
        replyMode,
        sendOpts,
        cardRenderOptions,
        turnId,
        outcome: handle.outcome,
        notice: noticeCtx,
        cliSelfSent,
        onWait: onDeliveryWait,
        onNotInChat,

      });
      return latestState;
    } else if (replyMode === 'markdown') {
      let latestState: RunState = seedRunState(runContext);
      let producerStarted = false;
      let producerRendered = false;
      let markdownCtrl: { messageId?: string; setContent(markdown: string): Promise<void> } | undefined;
      const progress = createLazyProgressStream(scope, replyMode, () =>
        outbox.stream(
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
          sendOpts,
          turnId,
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
        reliability,
      );
      const stream = await awaitRenderAwareStream({
        mode: replyMode,
        progress,
        renderDone,
        producerStarted: () => producerStarted,
        producerRendered: () => producerRendered,
        timeoutMs: outboundTimeoutMs,
      });
      await outbox.recallEmptyStream(progress, filterForPrefs(latestState), scope);
      const visible = filterForPrefs(latestState);
      const terminalState = finalAnswerOnly
        ? finalReplyState(stream, visible)
        : finalReplyFor(visible, { replyMode: 'stream-deltas', streamed: false });
      await outbox.deliverFinalReply({
        chatId,
        scope,
        state: terminalState,
        skipFrom: latestState,
        stream,
        dedicatedFinal: finalAnswerOnly,
        replyMode,
        sendOpts,
        cardRenderOptions,
        turnId,
        outcome: handle.outcome,
        notice: noticeCtx,
        cliSelfSent,
        onWait: onDeliveryWait,
        onNotInChat,

      });
      return latestState;
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
        reliability,
      );
      await outbox.deliverFinalReply({
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
        turnId,
        outcome: handle.outcome,
        notice: noticeCtx,
        cliSelfSent,
        onWait: onDeliveryWait,
        onNotInChat,

      });
      return finalState;
    }
  } finally {
    cliSelfSent?.consume(scope);
    scheduleWorkingReactionCleanup(channel, lastMsg.messageId, reactionPromise);
  }
}

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
      if (!handle.interrupted) watchdog.noteDelivered(evt);
      // A stopped run can still deliver its final resume handle before cleanup.
      // Keep draining owned events while suppressing further UI updates.
      if (evt.type === 'system') {
        recordSession(evt);
        continue;
      }
      if (!shouldDeliverAgentEvent(handle, evt)) continue;

      if (evt.type === 'liveness') continue;

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
      // The iterator joins settlement on return. Render the error only after
      // the executor has classified it, keeping raw CLI diagnostics off cards.
      if (evt.type === 'error') break;
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
  const failure = cliFailureInput(handle.run.stderrSnapshot,
    lastTerminal?.type === 'error' ? lastTerminal.message : undefined, signatures);
  const matched = matchCliSignature(failure.stderrTail, failure.signatures);
  const outcome = handle.outcome;
  if (!outcome) throw new Error('run settled without an outcome');
  noteUnclassifiedStderr({
    outcome,
    stderrTail: failure.stderrTail,
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
  outcome: RunOutcome,
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
}

function streamReliability(
  profile: { agentKind: string },
): StreamReliability {
  const kind = profile.agentKind;
  return {
    signatures: turnStderrSignatures(kind),
    agent: kind,
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


function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

/** Keep executor classification and turn presentation on the same declared signatures. */
export function turnStderrSignatures(kind: string, variant?: AgentPromptVariant): readonly CliSignature[] {
  const signatures = [...(isAgentKind(kind) ? descriptorFor(kind).stderrSignatures : []), ...NETWORK_TRANSIENT_SIGNATURES];
  return variant === 'automation' ? signatures.filter(signature => signature.classify.kind === 'partial') : signatures;
}
