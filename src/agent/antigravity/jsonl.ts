import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

export type AntigravityFinishReason = 'normal' | 'failed' | 'interrupted' | 'timeout';

export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

/**
 * Translates `agy -p --output-format stream-json` NDJSON into bridge
 * AgentEvents. Captured line shapes (Antigravity CLI 1.2.1):
 *
 *   {"event":"init","conversation_id":"<uuid>","init":{...}}
 *   {"event":"step_update","step_update":{"conversation_id","step_index","state","step_type","text_delta"?}}
 *   {"event":"result","result":{"conversation_id","status":"SUCCESS"|"ERROR","response","error"?,"usage"?}}
 *
 * `text_delta` fragments are held back. The reply body is `result.response`
 * (verified against a live Claude Sonnet print + resume). Unknown step types
 * increment protocol drift instead of throwing.
 */
export class AntigravityJsonlTranslator {
  private conversationId: string | undefined;
  private terminal = false;
  private pendingText = '';
  private systemEmitted = false;
  private drift: ProtocolDriftState = {
    unknownEvents: 0,
    anomalies: 0,
  };

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.event !== 'string') {
      this.drift.anomalies++;
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
        this.drift.unknownEvents++;
        log.warn('jsonl', 'unknown_event', { eventType: raw.event });
        return [];
    }
  }

  finish(reason: AntigravityFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      return this.prependHeldBack([
        {
          type: 'error',
          message: 'antigravity stream ended before a terminal event',
          terminationReason: 'failed',
        },
      ]);
    }
    return this.prependHeldBack([this.doneEvent(reason)]);
  }

  fail(message: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return this.prependHeldBack([
      { type: 'error', message: truncate(message, 4096), terminationReason: 'failed' },
    ]);
  }

  protocolDrift(): ProtocolDriftState {
    return { ...this.drift };
  }

  terminalEmitted(): boolean {
    return this.terminal;
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
      if (delta) this.pendingText += delta;
      return [];
    }
    if (
      stepType === 'user_input' ||
      stepType === 'system_message' ||
      stepType === 'error_message'
    ) {
      return [];
    }
    if (stepType) {
      this.drift.unknownEvents++;
      log.warn('jsonl', 'unknown_event', { eventType: stepType });
    } else {
      this.drift.anomalies++;
    }
    return [];
  }

  private translateResult(raw: Record<string, unknown>): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    const result = isRecord(raw.result) ? raw.result : raw;
    this.rememberConversation(result.conversation_id ?? raw.conversation_id);
    const events: AgentEvent[] = [...this.systemEvents()];
    const usage = this.usageEvent(result);
    if (usage) events.push(usage);
    const status = stringValue(result.status);
    if (status === 'ERROR' || status === 'FAILED') {
      const message =
        stringValue(result.error) ?? stringValue(result.message) ?? 'antigravity reported an error';
      events.push({ type: 'error', message: truncate(message, 4096), terminationReason: 'failed' });
      return events;
    }
    const response = typeof result.response === 'string' ? result.response : undefined;
    const content = response !== undefined && response.length > 0 ? response : this.pendingText;
    this.pendingText = '';
    if (content) events.push({ type: 'final_text', content });
    events.push(this.doneEvent('normal'));
    return events;
  }

  private rememberConversation(value: unknown): void {
    const id = stringValue(value);
    if (id) this.conversationId = id;
  }

  private prependHeldBack(events: AgentEvent[]): AgentEvent[] {
    const prefix: AgentEvent[] = [...this.systemEvents()];
    if (this.pendingText) {
      prefix.push({ type: 'final_text', content: this.pendingText });
      this.pendingText = '';
    }
    return prefix.length > 0 ? [...prefix, ...events] : events;
  }

  private systemEvents(): AgentEvent[] {
    if (this.systemEmitted || !this.conversationId) return [];
    this.systemEmitted = true;
    return [{ type: 'system', resumeHandle: this.conversationId }];
  }

  private doneEvent(reason: 'normal' | 'interrupted' | 'timeout'): AgentEvent {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
