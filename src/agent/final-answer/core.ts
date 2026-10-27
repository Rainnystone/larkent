import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

export interface AnswerPolicy {
  accumulation: 'message' | 'delta';
  preTool: 'discard' | 'progress' | 'fallback';
  separator: 'none' | 'paragraph' | 'line';
  clean?: (text: string) => string;
  hasAnswer?: (text: string) => boolean;
}
export interface ProtocolDriftState { unknownEvents: number; anomalies: number }
type Terminal = Extract<AgentEvent, { type: 'done' | 'error' }>;
export type FinalAnswerInput = AgentEvent
  | { type: 'answer'; text: string; messageId?: unknown }
  // Native tool boundary, which may precede tool_use while input is still arriving.
  | { type: 'boundary'; toolId?: string }
  | { type: 'complete'; terminal: Terminal; content?: string; prefix?: AgentEvent[]; suffix?: AgentEvent[]; emptyHint?: string };

/** One per run. Parsers supply protocol facts; this module owns answer and event ordering. */
export class FinalAnswerCore {
  private pending = '';
  private fallback = '';
  private messageId: unknown;
  private terminal = false;
  private readonly tools = new Set<string>();
  private readonly completedTools = new Set<string>();
  private readonly drift: ProtocolDriftState = { unknownEvents: 0, anomalies: 0 };
  constructor(private readonly policy: AnswerPolicy) {}

  accept(input: FinalAnswerInput): AgentEvent[] {
    if (this.terminal) return [];
    switch (input.type) {
      case 'answer': {
        const newMessage = input.messageId !== undefined && this.messageId !== undefined && input.messageId !== this.messageId;
        const replacement = this.policy.accumulation === 'message' && this.pending !== input.text;
        const events = newMessage || replacement ? this.classifySegment() : [];
        if (input.messageId !== undefined) this.messageId = input.messageId;
        this.pending = this.policy.accumulation === 'delta' ? this.pending + input.text : input.text;
        return [...events, { type: 'liveness' }];
      }
      case 'boundary':
        // A fresh native start may reuse a completed ID; updates do not reopen it.
        if (input.toolId) this.completedTools.delete(input.toolId);
        return this.classifySegment();
      case 'complete': return this.complete(input);
      case 'done':
      case 'error': return this.complete({ type: 'complete', terminal: input });
      case 'tool_use': {
        if (this.tools.has(input.id) || this.completedTools.has(input.id)) return [{ type: 'liveness' }];
        this.tools.add(input.id);
        return [input];
      }
      case 'tool_result': {
        if (!this.tools.delete(input.id)) {
          this.anomaly();
          return [{ type: 'liveness' }];
        }
        this.completedTools.add(input.id);
        return [input];
      }
      case 'system':
        return input.resumeHandle || input.cwd || input.model ? [input] : [{ type: 'liveness' }];
      default: return [input];
    }
  }

  protocolDrift(): ProtocolDriftState { return { ...this.drift }; }
  terminalEmitted(): boolean { return this.terminal; }
  anomaly(): void { this.drift.anomalies++; }
  unknown(eventType: string): void {
    this.drift.unknownEvents++;
    log.warn('jsonl', 'unknown_event', { eventType });
  }

  private complete(input: Extract<FinalAnswerInput, { type: 'complete' }>): AgentEvent[] {
    this.terminal = true;
    const successful = input.terminal.type === 'done' && input.terminal.terminationReason === 'normal';
    let answer: AgentEvent[];
    if (successful) {
      const pending = this.clean(input.content ?? this.pending);
      const content = this.fallback && !this.hasAnswer(pending) ? this.fallback : pending;
      const final = content || input.emptyHint;
      answer = final ? [{ type: 'final_text', content: final }] : [];
    } else {
      // Preserve the explicitly requested stopped partial reply without labelling it a successful final.
      if (input.terminal.type === 'done' && input.terminal.terminationReason !== 'normal') {
        const pending = this.clean(this.pending);
        const text = this.fallback && !this.hasAnswer(pending) ? this.fallback : pending;
        answer = text ? [{ type: 'text', delta: text, heldBack: true }] : [];
      } else {
        answer = this.progress();
      }
    }
    this.pending = '';
    const tools: AgentEvent[] = [...this.tools].map(id => ({ type: 'tool_result', id, output: 'Tool did not complete before the run ended.', isError: true }));
    this.tools.clear();
    return [...input.prefix ?? [], ...answer, ...tools, ...input.suffix ?? [], input.terminal];
  }

  private classifySegment(): AgentEvent[] {
    this.messageId = undefined;
    const pending = this.clean(this.pending);
    if (this.policy.preTool === 'fallback' && this.hasAnswer(pending)) this.fallback = pending;
    if (this.policy.preTool === 'discard' || !this.hasAnswer(pending)) {
      this.pending = '';
      return [];
    }
    return this.progress();
  }

  private clean(text: string): string { return this.policy.clean?.(text) ?? text; }
  private hasAnswer(text: string): boolean { return this.policy.hasAnswer?.(text) ?? Boolean(text); }
  private progress(): AgentEvent[] {
    const text = this.clean(this.pending);
    this.pending = '';
    if (!text) return [];
    const delta = this.policy.separator === 'none' || (this.policy.separator === 'line' && text.endsWith('\n'))
      ? text : `${text}\n\n`;
    return [{ type: 'text', delta }];
  }
}
