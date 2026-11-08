import type { AgentEvent } from '../types';
import { FinalAnswerCore, type ProtocolDriftState } from '../final-answer/core';
import {
  isRecord,
  nonEmptyString as stringValue,
  finiteNumber as numberValue,
  record,
  recordValue,
  truncate,
} from '../final-answer/values';
import { log, redactDiagnosticText } from '../../core/logger';
import { scrubSystemMessageEnvelopes } from './envelopes';

export type AntigravityFinishReason = 'normal' | 'failed' | 'interrupted' | 'timeout';

const PRINT_TIMEOUT_HINT =
  'Antigravity print-timeout reached before a reply was produced.';
const TERMINAL_RESULT_ERROR_CHARS = 200;

function logTerminalResult(raw: Record<string, unknown>, result: Record<string, unknown>): void {
  const status = stringValue(result.status);
  const conversationId = stringValue(result.conversation_id) ?? stringValue(raw.conversation_id);
  const numTurns = numberValue(result.num_turns);
  const errorMessage = stringValue(result.error);
  const errorCode = stringValue(result.error_code);
  const errorType = stringValue(result.error_type);
  log.info('agent', 'terminal-result', {
    ...(status ? { status } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorType ? { errorType } : {}),
    ...(errorMessage
      ? { errorMessage: truncate(redactDiagnosticText(errorMessage), TERMINAL_RESULT_ERROR_CHARS) }
      : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(numTurns !== undefined ? { numTurns } : {}),
  });
}

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
 * `agent_response` `text_delta` fragments are held back. `tool` ACTIVE/DONE
 * pair by `(conversation_id, step_index)` (and captured `subagent_info` when
 * present). `checkpoint` stays a liveness ping, not a tool start. An empty SUCCESS
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
  private readonly openTools = new Map<string, OpenAgyTool>();

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
      : this.core.accept({ type: 'complete', terminal: this.doneEvent(reason), prefix: this.systemEvents() });
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
    if (stepType === 'checkpoint') {
      this.sawRecognizedToolOrCheckpoint = true;
      return [{ type: 'liveness' }];
    }
    if (stepType === 'tool') {
      this.sawRecognizedToolOrCheckpoint = true;
      return this.translateToolStep(step);
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
    logTerminalResult(raw, result);
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

  private translateToolStep(step: Record<string, unknown>): AgentEvent[] {
    const identity = this.toolIdentity(step);
    if (!identity) {
      this.core.anomaly();
      return [{ type: 'liveness' }];
    }
    const state = stringValue(step.state);
    if (state === 'ACTIVE') {
      this.openTools.set(identity.id, identity);
      const info = recordValue(step.tool_info);
      const name = stringValue(step.tool_name) ?? stringValue(info?.name) ?? 'tool';
      // Skip FinalAnswerCore's native boundary: result.response is the
      // authoritative answer, and classifying pre-tool deltas would duplicate it.
      return this.core.accept({
        type: 'tool_use',
        id: identity.id,
        name,
        input: toolInput(info),
      });
    }
    if (state === 'DONE') {
      const id = this.resolveCloseId(identity);
      if (!id) return [{ type: 'liveness' }];
      this.openTools.delete(id);
      const info = recordValue(step.tool_info);
      return this.core.accept({
        type: 'tool_result',
        id,
        output: stringValue(info?.output) ?? '',
        isError: false,
      });
    }
    return [{ type: 'liveness' }];
  }

  private toolIdentity(step: Record<string, unknown>): OpenAgyTool | undefined {
    const conversationId = stringValue(step.conversation_id) ?? this.conversationId;
    const stepIndex = numberValue(step.step_index);
    if (!conversationId || stepIndex === undefined) return undefined;
    const sub = recordValue(step.subagent_info);
    const subagent = stringValue(sub?.name) ?? stringValue(sub?.id) ?? '';
    return {
      id: subagent ? `${conversationId}:${stepIndex}:${subagent}` : `${conversationId}:${stepIndex}`,
      conversationId,
      stepIndex,
      subagent,
    };
  }

  private resolveCloseId(identity: OpenAgyTool): string | undefined {
    if (this.openTools.has(identity.id)) return identity.id;
    if (identity.subagent !== '') return undefined;
    const matches = [...this.openTools.values()].filter((open) => (
      open.conversationId === identity.conversationId && open.stepIndex === identity.stepIndex
    ));
    return matches.length === 1 ? matches[0]?.id : undefined;
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

interface OpenAgyTool {
  id: string;
  conversationId: string;
  stepIndex: number;
  subagent: string;
}

function toolInput(info: Record<string, unknown> | undefined): Record<string, unknown> {
  const parameters = record(info?.parameters);
  const commandLine = stringValue(parameters.CommandLine);
  if (commandLine !== undefined && parameters.command === undefined) {
    return { ...parameters, command: commandLine };
  }
  return { ...parameters };
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
