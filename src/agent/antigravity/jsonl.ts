import type { AgentEvent } from '../types';
import { FinalAnswerCore, type ProtocolDriftState } from '../final-answer/core';
import { isRecord, nonEmptyString as stringValue, finiteNumber as numberValue, truncate } from '../final-answer/values';
import { log } from '../../core/logger';
import { scrubSystemMessageEnvelopes } from './envelopes';

export type AntigravityFinishReason = 'normal' | 'failed' | 'interrupted' | 'timeout';

const PRINT_TIMEOUT_HINT =
  'Antigravity print-timeout reached before a reply was produced.';

/**
 * Translates `agy -p --output-format stream-json` NDJSON into bridge
 * AgentEvents. Captured line shapes (Antigravity CLI 1.2.1):
 *
 *   {"event":"init","conversation_id":"<uuid>","init":{...}}
 *   {"event":"step_update","step_update":{"conversation_id","step_index","state","step_type","text_delta"?,"tool_name"?,"tool_info"?}}
 *   {"event":"result","result":{"conversation_id","status":"SUCCESS"|"ERROR","response","error"?,"usage"?}}
 *
 * Official `step_type` values `user_input`, `agent_response`, `tool`,
 * `checkpoint`, plus silent `system_message` / `error_message`, are known.
 * `agent_response` `text_delta` fragments are held back. `tool` and
 * `checkpoint` are parse-only (no tool/text events). An empty SUCCESS
 * after print-timeout is classified (official timeout field, else the
 * incident heuristic) and emits a `final_text` hint so outbound is not
 * muted. The reply body is `result.response` (verified against a live
 * Claude Sonnet print + resume). Strings that become `final_text` run
 * through the envelope classifier first.
 * Unknown step types increment protocol drift instead of throwing.
 */
export class AntigravityJsonlTranslator {
  private conversationId: string | undefined;
  // D03a: transcripts/antigravity/narration-tool-answer.jsonl: result.response is authoritative;
  // Envelope scrubbing retains the existing system-message-envelope-incident.jsonl behavior (D03b).
  private readonly core = new FinalAnswerCore({ accumulation: 'delta', preTool: 'progress', separator: 'none', clean: text => scrubFinalText(text, this.sawSystemMessageStep) });
  private systemEmitted = false;
  private sawRecognizedToolOrCheckpoint = false;
  private sawSystemMessageStep = false;

  translate(raw: unknown): AgentEvent[] {
    if (this.core.terminalEmitted()) return [];
    if (!isRecord(raw) || typeof raw.event !== 'string') {
      this.core.anomaly();
      return [];
    }

    switch (raw.event) {
      case 'init':
        return this.translateInit(raw);
      case 'step_update':
        return this.translateStep(raw);
      case 'result':
        return this.translateResult(raw);
      default:
        this.core.unknown(raw.event);
        return [];
    }
  }

  finish(reason: AntigravityFinishReason = 'failed'): AgentEvent[] {
    return reason === 'failed' ? this.fail('antigravity stream ended before a terminal event')
      : this.core.accept({ type: 'complete', terminal: this.doneEvent(reason), prefix: this.systemEvents(), progressOnly: true });
  }

  fail(message: string): AgentEvent[] {
    return this.core.accept({ type: 'complete', terminal: { type: 'error', message: truncate(message, 4096), terminationReason: 'failed' }, prefix: this.systemEvents() });
  }

  protocolDrift(): ProtocolDriftState {
    return this.core.protocolDrift();
  }

  terminalEmitted(): boolean {
    return this.core.terminalEmitted();
  }

  private translateInit(raw: Record<string, unknown>): AgentEvent[] {
    this.rememberConversation(raw.conversation_id);
    const init = isRecord(raw.init) ? raw.init : undefined;
    if (init) this.rememberConversation(init.conversation_id);
    return this.systemEvents();
  }

  private translateStep(raw: Record<string, unknown>): AgentEvent[] {
    const step = isRecord(raw.step_update) ? raw.step_update : raw;
    this.rememberConversation(step.conversation_id);
    const stepType = stringValue(step.step_type);
    if (stepType === 'agent_response') {
      const delta = stringValue(step.text_delta);
      return delta ? this.core.accept({ type: 'answer', text: delta }) : [];
    }
    if (stepType === 'system_message') {
      this.sawSystemMessageStep = true;
      return [];
    }
    if (stepType === 'user_input' || stepType === 'error_message') {
      return [];
    }
    if (stepType === 'tool' || stepType === 'checkpoint') {
      this.sawRecognizedToolOrCheckpoint = true;
      return [{ type: 'liveness' }];
    }
    if (stepType) {
      this.core.unknown(stepType);
    } else {
      this.core.anomaly();
    }
    return [];
  }

  private translateResult(raw: Record<string, unknown>): AgentEvent[] {
    if (this.core.terminalEmitted()) return [];
    const result = isRecord(raw.result) ? raw.result : raw;
    this.rememberConversation(result.conversation_id ?? raw.conversation_id);
    const events: AgentEvent[] = [...this.systemEvents()];
    const usage = this.usageEvent(result);
    if (usage) events.push(usage);
    const status = stringValue(result.status);
    if (status === 'ERROR' || status === 'FAILED') {
      const message =
        stringValue(result.error) ?? stringValue(result.message) ?? 'antigravity reported an error';
      return this.core.accept({ type: 'complete', terminal: { type: 'error', message: truncate(message, 4096), terminationReason: 'failed' }, prefix: events });
    }
    const response = typeof result.response === 'string' ? result.response : undefined;
    return this.core.accept({ type: 'complete', terminal: this.doneEvent('normal'),
      prefix: events, ...(response ? { content: response } : {}), emptyHint: this.emptySuccessHint(result) });
  }

  private emptySuccessHint(result: Record<string, unknown>): string | undefined {
    if (officialPrintTimeoutSignal(result)) return PRINT_TIMEOUT_HINT;
    if (this.sawRecognizedToolOrCheckpoint) return PRINT_TIMEOUT_HINT;
    return undefined;
  }

  private rememberConversation(value: unknown): void {
    const id = stringValue(value);
    if (id) this.conversationId = id;
  }

  private systemEvents(): AgentEvent[] {
    if (this.systemEmitted || !this.conversationId) return [];
    this.systemEmitted = true;
    return [{ type: 'system', resumeHandle: this.conversationId }];
  }

  private doneEvent(reason: 'normal' | 'interrupted' | 'timeout'): Extract<AgentEvent, { type: 'done' }> {
    return {
      type: 'done',
      ...(this.conversationId ? { resumeHandle: this.conversationId } : {}),
      terminationReason: reason,
    };
  }

  private usageEvent(raw: Record<string, unknown>): AgentEvent | undefined {
    const usage = isRecord(raw.usage) ? raw.usage : raw;
    const inputTokens = numberValue(usage.input_tokens) ?? numberValue(usage.inputTokens);
    const outputTokens = numberValue(usage.output_tokens) ?? numberValue(usage.outputTokens);
    const cachedInputTokens =
      numberValue(usage.cache_read_tokens) ?? numberValue(usage.cachedInputTokens);
    const reasoningOutputTokens =
      numberValue(usage.thinking_tokens) ?? numberValue(usage.reasoningOutputTokens);
    if (
      !nonzero(inputTokens) &&
      !nonzero(outputTokens) &&
      !nonzero(cachedInputTokens) &&
      !nonzero(reasoningOutputTokens)
    ) {
      return undefined;
    }
    return {
      type: 'usage',
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    };
  }
}

function nonzero(value: number | undefined): boolean {
  return value !== undefined && value !== 0;
}

function officialPrintTimeoutSignal(result: Record<string, unknown>): boolean {
  return isTimeoutSignal(stringValue(result.error)) || isTimeoutSignal(stringValue(result.reason));
}

function isTimeoutSignal(value: string | undefined): boolean {
  return value !== undefined && /timeout/i.test(value);
}

function scrubFinalText(
  content: string,
  sawSystemMessageStep: boolean,
): string {
  const scrubbed = scrubSystemMessageEnvelopes(content);
  if (scrubbed.removedByFamily.system_message > 0) {
    log.info('jsonl', 'system_message_scrubbed', {
      beforeLength: scrubbed.beforeLength,
      afterLength: scrubbed.afterLength,
      removedCount: scrubbed.removedByFamily.system_message,
      unclosed: scrubbed.unclosed,
      preambleRemoved: scrubbed.preambleRemoved,
      sawSystemMessageStep,
    });
  }
  if (scrubbed.removedByFamily.task_notification > 0) {
    log.info('jsonl', 'task_notification_scrubbed', {
      beforeLength: scrubbed.beforeLength,
      afterLength: scrubbed.afterLength,
      removedCount: scrubbed.removedByFamily.task_notification,
      unclosed: scrubbed.unclosed,
      preambleRemoved: scrubbed.preambleRemoved,
      family: 'task_notification',
      sawSystemMessageStep,
    });
  }
  for (const reason of scrubbed.retainedReasons) {
    log.info('jsonl', 'system_message_tag_retained', { reason });
  }
  for (const reason of scrubbed.taskNotificationRetainedReasons) {
    log.info('jsonl', 'task_notification_tag_retained', { reason });
  }
  return scrubbed.text;
}
