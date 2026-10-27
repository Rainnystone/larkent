import type { AgentEvent } from '../types';
import { FinalAnswerCore, type ProtocolDriftState } from '../final-answer/core';
import { isRecord, recordValue, stringValue, numberValue, truncate } from '../final-answer/values';
import { log } from '../../core/logger';

export type CodexFinishReason = 'failed' | 'interrupted' | 'timeout';

export class CodexJsonlTranslator {
  private threadId: string | undefined;
  // D03a: transcripts/codex/narration-tool-answer.jsonl separates messages around tools.
  private readonly core = new FinalAnswerCore({ accumulation: 'message', preTool: 'progress', separator: 'none' });
  private lastNonTerminalError: string | undefined;

  translate(raw: unknown): AgentEvent[] {
    if (this.core.terminalEmitted()) return [];
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      this.core.anomaly();
      return [];
    }

    switch (raw.type) {
      case 'thread.started':
        return this.translateThreadStarted(raw);
      case 'turn.started':
        return [{ type: 'liveness' }];
      case 'item.started':
        return this.translateItemStarted(raw);
      case 'item.completed':
        return this.translateItemCompleted(raw);
      case 'agent_message':
        return this.translateAgentMessage(raw);
      case 'turn.completed':
        return this.translateTurnCompleted(raw);
      case 'turn.failed':
        return this.translateTerminalError(raw, 'codex turn failed');
      case 'error':
        return this.translateNonTerminalError(raw, 'codex error');
      default:
        this.core.unknown(raw.type);
        return [];
    }
  }

  finish(reason: CodexFinishReason = 'failed'): AgentEvent[] {
    const detail = this.lastNonTerminalError ? `: ${this.lastNonTerminalError}` : '';
    return reason === 'failed'
      ? this.fail(`codex stream ended before a terminal event${detail}`)
      : this.core.accept({ type: 'done', resumeHandle: this.threadId, terminationReason: reason });
  }

  fail(message: string): AgentEvent[] {
    return this.core.accept({ type: 'error', message: truncate(message, 4096), terminationReason: 'failed' });
  }

  protocolDrift(): ProtocolDriftState {
    return this.core.protocolDrift();
  }

  terminalEmitted(): boolean {
    return this.core.terminalEmitted();
  }

  private translateThreadStarted(raw: Record<string, unknown>): AgentEvent[] {
    const threadId = stringValue(raw.thread_id ?? raw.threadId);
    if (!threadId) {
      this.core.anomaly();
      return [];
    }
    this.threadId = threadId;
    return [{ type: 'system', resumeHandle: threadId }];
  }

  private translateItemStarted(raw: Record<string, unknown>): AgentEvent[] {
    const item = recordValue(raw.item);
    if (!item || item.type !== 'command_execution') return [];
    const id = stringValue(item.id);
    if (!id) {
      this.core.anomaly();
      return [];
    }
    return this.core.accept(
      {
        type: 'tool_use',
        id,
        name: 'command_execution',
        input: {
          command: stringValue(item.command) ?? '',
        },
      },
    );
  }

  private translateItemCompleted(raw: Record<string, unknown>): AgentEvent[] {
    const item = recordValue(raw.item);
    if (!item) return [];
    if (item.type === 'agent_message') {
      const message = stringValue(item.text ?? item.message);
      return message ? this.core.accept({ type: 'answer', text: message }) : [];
    }
    if (item.type !== 'command_execution') return [];
    const id = stringValue(item.id);
    if (!id) {
      this.core.anomaly();
      return [];
    }
    const exitCode = numberValue(item.exit_code);
    return [...this.core.accept({ type: 'boundary' }), ...this.core.accept(
      {
        type: 'tool_result',
        id,
        output: stringValue(item.output ?? item.aggregated_output ?? item.stdout) ?? '',
        isError: exitCode !== undefined && exitCode !== 0,
      },
    )];
  }

  private translateAgentMessage(raw: Record<string, unknown>): AgentEvent[] {
    const message = stringValue(raw.message ?? raw.text);
    if (!message) return [];
    return this.core.accept({ type: 'answer', text: message });
  }

  private translateTurnCompleted(raw: Record<string, unknown>): AgentEvent[] {
    const events: AgentEvent[] = [];
    const usage = recordValue(raw.usage);
    if (usage) {
      events.push({
        type: 'usage',
        inputTokens: numberValue(usage.input_tokens ?? usage.inputTokens),
        outputTokens: numberValue(usage.output_tokens ?? usage.outputTokens),
        cachedInputTokens: numberValue(usage.cached_input_tokens ?? usage.cachedInputTokens),
        reasoningOutputTokens: numberValue(
          usage.reasoning_output_tokens ?? usage.reasoningOutputTokens,
        ),
      });
    }
    return this.core.accept({ type: 'complete', terminal: { type: 'done', resumeHandle: this.threadId, terminationReason: 'normal' }, suffix: events });
  }

  private translateTerminalError(raw: Record<string, unknown>, fallback: string): AgentEvent[] {
    return this.fail(errorMessage(raw, fallback));
  }

  private translateNonTerminalError(raw: Record<string, unknown>, fallback: string): AgentEvent[] {
    const message = errorMessage(raw, fallback);
    this.lastNonTerminalError = message;
    log.warn('jsonl', 'error_event', { message: truncate(message, 500) });
    return [];
  }
}

function errorMessage(raw: Record<string, unknown>, fallback: string): string {
  const nested = recordValue(raw.error);
  return (
    stringValue(raw.message) ??
    stringValue(nested?.message) ??
    stringValue(raw.error) ??
    fallback
  );
}
