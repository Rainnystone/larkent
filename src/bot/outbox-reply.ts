import type { LarkChannel } from '@larksuite/channel';
import { renderCard } from '../card/run-renderer';
import { renderText } from '../card/text-renderer';
import { shouldSkipFinalReply, type RunState } from '../card/run-state';
import { OUTBOUND_SKIP_CLI_SENT_METRIC } from '../card/direct-im-send';
import { stripLegacyAutomationTagsFromState } from '../card/legacy-automation-tags';
import { getMessageReplyMode } from '../config/schema';
import { log, reportMetric } from '../core/logger';
import type { CliSelfSendTracker } from './self-message';
import type { Continuations } from './continuation';
import type { RunOutcome } from './run-outcome';
import {
  NoticeActionAuth,
  planInterruptionNotice,
} from './interruption-notice';
import {
  authNoticeAlreadyDelivered,
  deliverInterruptionNotice,
  stageInterruptionNotice,
} from './outbox-notice';
import {
  classify,
  isNotInChat,
  isSupersededMessageGone,
  rateLimitResetDelayMs,
} from './feishu-error';
import { redeliverStagedReply, withDeliveryUuid } from './feishu-delivery';
import {
  noticeState,
  replyState,
  replyDeliveryKey,
  type TurnJournal,
  type TurnJournalEntry,
} from './turn-journal';

export type StreamDelivery =
  | { kind: 'confirmed'; messageId: string }
  | { kind: 'failed'; err: unknown; messageId?: string }
  | { kind: 'none' };

function threadIdForReply(
  journal: TurnJournal,
  turnId: string,
): { threadId: string } | Record<string, never> {
  const threadId = journal.get(turnId)?.threadId?.trim();
  return threadId ? { threadId } : {};
}

export async function deliverFinalReply(input: {
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
  outcome?: RunOutcome;
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
}): Promise<void> {
  if (input.journal && input.turnId && input.outcome) {
    input.journal.markSettled(input.turnId, input.outcome);
  }
  const state = stripLegacyAutomationTagsFromState(input.state);
  const skipFrom = input.skipFrom
    ? stripLegacyAutomationTagsFromState(input.skipFrom)
    : undefined;
  const stateText = renderText(state);
  const replyState = stateText.trim() ? state : (skipFrom ?? state);
  const visibleBody = renderText(replyState);
  const cliSent =
    input.cliSelfSent?.has(input.scope) === true &&
    (input.skipFrom ?? input.state).terminal === 'done';
  const skipCli =
    shouldSkipFinalReply(input.skipFrom ?? input.state, input.chatId) ||
    cliSent;
  const skip = skipCli || !visibleBody.trim();
  if (input.journal && input.turnId && skipCli) {
    input.journal.noteCliAlreadySent(input.turnId);
  }
  const outcome = input.outcome;
  const willNotice = Boolean(
    input.notice &&
      input.journal &&
      input.turnId &&
      outcome &&
      planInterruptionNotice(outcome).kind !== 'none',
  );
  const deliveryId = input.turnId
    ? (input.journal?.get(input.turnId)?.reply?.deliveryId ??
      replyDeliveryKey(input.turnId))
    : undefined;
  const stream = input.stream ?? { kind: 'none' as const };
  const dedicatedFinal =
    input.dedicatedFinal === true && Boolean(stateText.trim());
  const streamMessageId = stream.kind === 'none' ? undefined : stream.messageId;
  if (dedicatedFinal && streamMessageId && input.journal && input.turnId) {
    input.journal.noteNonAnswerId(input.turnId, streamMessageId);
  }
  const reply = {
    markdown: visibleBody,
    replyTo: input.sendOpts.replyTo,
    replyMode: input.replyMode,
    ...(input.sendOpts.replyInThread ? { replyInThread: true } : {}),
    ...(input.journal && input.turnId
      ? threadIdForReply(input.journal, input.turnId)
      : {}),
    ...(deliveryId ? { deliveryId } : {}),
    ...(!dedicatedFinal && streamMessageId
      ? { messageId: streamMessageId, interactive: true as const }
      : {}),
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
  // Session switches may void this turn while the staged snapshot is flushing.
  if (
    input.journal &&
    input.turnId &&
    input.journal.get(input.turnId)?.status === 'voided'
  )
    return;
  if (skipCli) {
    log.info('outbound', 'skip-cli-already-sent', {
      scope: input.scope,
      chatId: input.chatId,
      mode: input.replyMode,
    });
    reportMetric(OUTBOUND_SKIP_CLI_SENT_METRIC, 1);
  } else if (skip && stream.kind === 'none') {
    log.info('outbound', 'skip-empty', {
      scope: input.scope,
      mode: input.replyMode,
    });
  } else if (input.link?.isDown()) {
    if (deferJournalFlush && input.journal) await input.journal.flush();
    return;
  } else {
    try {
      const settled = await settleStreamDelivery({
        stream,
        channel: input.channel,
        body: visibleBody,
        send: () =>
          sendFinalReply({
            ...input,
            deliveryId,
            state: replyState,
          }),
        fallback: () =>
          sendPlainTextReply({
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
        return;
      }
    } catch (error) {
      if (deferJournalFlush && input.journal) await input.journal.flush();
      if (isNotInChat(error)) await input.onNotInChat?.(input.chatId);
      throw error;
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
}

type OutboundSettle = { kind: 'done' } | { kind: 'wait'; error?: unknown };

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
async function recallReplacedMessage(
  channel: LarkChannel,
  messageId: string,
): Promise<SupersedeRecall> {
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
          input.journal.noteReplyReceipt(
            input.turnId,
            input.stream.messageId,
            true,
          );
        }
        if (input.dedicatedFinal) await input.journal.flush();
      }
      return input.dedicatedFinal ? sendOrWait(input) : { kind: 'done' };
    case 'none':
      return sendOrWait(input);
    case 'failed':
      log.fail('stream', input.stream.err, {
        mode: input.replyMode,
        step: 'final-patch',
      });
      if (input.stream.messageId && input.journal && input.turnId) {
        if (input.dedicatedFinal) {
          input.journal.noteNonAnswerId(input.turnId, input.stream.messageId);
        } else {
          input.journal.noteReplyReceipt(
            input.turnId,
            input.stream.messageId,
            true,
          );
        }
        await input.journal.flush();
      }
      if (input.dedicatedFinal) return sendOrWait(input);
      if (input.stream.messageId)
        return { kind: 'wait', error: input.stream.err };
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
          if (input.journal && input.turnId)
            input.journal.replyRejected(input.turnId);
          throw err;
        }
        if (!input.fallback) {
          if (input.journal && input.turnId)
            input.journal.replyRejected(input.turnId);
          return { kind: 'done' };
        }
        try {
          return await recordSend({ ...input, send: input.fallback });
        } catch (retryErr) {
          log.fail('outbound', retryErr, {
            mode: input.replyMode,
            step: 'final-send',
          });
          if (classify(retryErr) === 'link')
            return { kind: 'wait', error: retryErr };
          if (input.journal && input.turnId)
            input.journal.replyRejected(input.turnId);
          if (isNotInChat(retryErr)) throw retryErr;
          return { kind: 'done' };
        }
      }
      case 'local':
        try {
          return await recordSend(input);
        } catch (retryErr) {
          log.fail('outbound', retryErr, {
            mode: input.replyMode,
            step: 'final-send',
          });
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
    input.journal.noteReplyReceipt(
      input.turnId,
      sent.messageId,
      input.replyMode === 'card',
    );
  }
  return { kind: 'done' };
}

export async function resendJournalReply(input: {
  channel: LarkChannel;
  journal: TurnJournal;
  entry: TurnJournalEntry;
  botAppId: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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
        ...(input.sleep ? { sleep: input.sleep } : {}),
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

function journalReplyMode(
  mode: string | undefined,
): ReturnType<typeof getMessageReplyMode> {
  switch (mode) {
    case 'card':
    case 'markdown':
    case 'text':
      return mode;
    default:
      return 'text';
  }
}

export function stagedOutboxCount(journal: TurnJournal): number {
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
    log.info('outbound', 'skip-empty', {
      scope: input.scope,
      mode: input.replyMode,
    });
    return undefined;
  }

  const sendOpts = withDeliveryUuid(
    input.sendOpts,
    input.deliveryId ??
      (input.turnId ? replyDeliveryKey(input.turnId) : undefined),
  );

  if (input.replyMode === 'card') {
    const result = await input.channel.send(
      input.chatId,
      { card: renderCard(input.state, input.cardRenderOptions) },
      sendOpts,
    );
    requireMessageReceipt(result, 'card');
    log.info(
      'outbound',
      'sent',
      outboundLogFields(input, 'card', body, result),
    );
    return result;
  }
  if (input.replyMode === 'markdown') {
    const result = await input.channel.send(
      input.chatId,
      { markdown: body },
      sendOpts,
    );
    requireMessageReceipt(result, 'markdown');
    log.info(
      'outbound',
      'sent',
      outboundLogFields(input, 'markdown', body, result),
    );
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

function requireMessageReceipt(
  result: { messageId?: string },
  type: string,
): void {
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
    withDeliveryUuid(
      {
        ...(replyTo ? { replyTo } : {}),
        ...(input.sendOpts.replyInThread ? { replyInThread: true } : {}),
      },
      input.deliveryId,
    ),
  );
  requireMessageReceipt(result, 'text');
  return result;
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
  if (plan.kind === 'continue')
    input.notice.continuations.offer(input.turnId, input.outcome);
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
  const entry = input.journal.get(input.turnId);
  if (!entry || noticeState(entry) !== 'staged' || input.link?.isDown()) return;
  const result = await deliverInterruptionNotice({
    send: (chatId, content, options) =>
      input.channel.send(chatId, content, options),
    ...noticeArgs(input),
  });
  if (!result.delivered) input.onWait?.();
}

/**
 * Backstop for a progress stream that was opened on real content and still
 * ended up empty — e.g. `/config` hiding tool calls mid-run, which retroactively
 * empties a tool-only render. The SDK fills such a card with its "(no content)"
 * placeholder, so recall it instead of leaving noise in the chat.
 *
 * `finalState` must already be `filterForPrefs`-projected (what the user sees).
 */
export async function recallIfEmptyStreamedReply(
  channel: LarkChannel,
  progress: {
    opened(): boolean;
    abandoned(): boolean;
    settled: Promise<unknown>;
  },
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
  const messageId = (streamResult as { messageId?: string } | undefined)
    ?.messageId;
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
