import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

export type KimiFinishReason = 'normal' | 'failed' | 'interrupted' | 'timeout';

export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

/**
 * Translates kimi's `kimi -p --output-format stream-json` JSONL into bridge
 * AgentEvents. Observed line shapes (kimi 0.38.0):
 *
 *   {"role":"meta","type":"system.version","version":"0.38.0"}
 *   {"role":"assistant","tool_calls":[{"type":"function","id":"tool_x",
 *     "function":{"name":"Bash","arguments":"{\"command\":\"...\"}"}}]}
 *   {"role":"tool","tool_call_id":"tool_x","content":"..."}
 *   {"role":"assistant","content":"..."}
 *   {"role":"meta","type":"session.resume_hint","session_id":"session_...", ...}
 *
 * There is no terminal "result" line and no usage accounting: the stream
 * simply ends after `session.resume_hint`, so the adapter calls finish()
 * once the process exits cleanly. Intermediate assistant texts (progress
 * commentary before/between tool calls) are forwarded as `text` deltas; the
 * last one is held back and becomes the run's `final_text`.
 */
export class KimiJsonlTranslator {
  private sessionId: string | undefined;
  private version: string | undefined;
  private terminal = false;
  private pendingAssistantText: string | undefined;
  private readonly startedToolCalls = new Set<string>();
  private drift: ProtocolDriftState = {
    unknownEvents: 0,
    anomalies: 0,
  };

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.role !== 'string') {
      this.drift.anomalies++;
      return [];
    }

    switch (raw.role) {
      case 'meta':
        return this.translateMeta(raw);
      case 'assistant':
        return this.translateAssistant(raw);
      case 'tool':
        return this.prependPendingText(this.translateToolResult(raw));
      default:
        this.drift.unknownEvents++;
        log.warn('jsonl', 'unknown_event', { eventType: raw.role });
        return [];
    }
  }

  finish(reason: KimiFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      return this.prependPendingText([
        {
          type: 'error',
          message: 'kimi stream ended before a terminal event',
          terminationReason: 'failed',
        },
      ]);
    }
    const events: AgentEvent[] = [];
    if (this.pendingAssistantText) {
      events.push({ type: 'final_text', content: this.pendingAssistantText });
      this.pendingAssistantText = undefined;
    }
    events.push({
      type: 'done',
      ...(this.sessionId ? { resumeHandle: this.sessionId } : {}),
      terminationReason: reason,
    });
    return events;
  }

  fail(message: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return this.prependPendingText([
      { type: 'error', message: truncate(message, 4096), terminationReason: 'failed' },
    ]);
  }

  protocolDrift(): ProtocolDriftState {
    return { ...this.drift };
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private translateMeta(raw: Record<string, unknown>): AgentEvent[] {
    const metaType = stringValue(raw.type);
    switch (metaType) {
      case 'system.version':
        this.version = stringValue(raw.version) ?? this.version;
        return [];
      case 'session.resume_hint': {
        const sessionId = stringValue(raw.session_id);
        if (!sessionId) {
          this.drift.anomalies++;
          return [];
        }
        this.sessionId = sessionId;
        return [{ type: 'system', resumeHandle: sessionId }];
      }
      default:
        this.drift.unknownEvents++;
        log.warn('jsonl', 'unknown_event', { eventType: `meta:${metaType ?? '?'}` });
        return [];
    }
  }

  private translateAssistant(raw: Record<string, unknown>): AgentEvent[] {
    if (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
      return this.prependPendingText(this.translateToolCalls(raw.tool_calls));
    }
    const content = stringValue(raw.content);
    return content ? this.queueAssistantText(content) : [];
  }

  private translateToolCalls(toolCalls: unknown[]): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const call of toolCalls) {
      if (!isRecord(call)) {
        this.drift.anomalies++;
        continue;
      }
      const id = stringValue(call.id);
      const fn = recordValue(call.function);
      const name = fn ? stringValue(fn.name) : undefined;
      if (!id || !name) {
        this.drift.anomalies++;
        continue;
      }
      this.startedToolCalls.add(id);
      events.push({
        type: 'tool_use',
        id,
        name,
        input: parseToolArguments(fn?.arguments),
      });
    }
    return events;
  }

  private translateToolResult(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.tool_call_id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    if (!this.startedToolCalls.has(id)) {
      this.drift.anomalies++;
    }
    this.startedToolCalls.delete(id);
    // kimi's tool line carries no error flag; surface every result as
    // non-error and let the agent's own follow-up text describe failures.
    return [
      {
        type: 'tool_result',
        id,
        output: stringValue(raw.content) ?? '',
        isError: false,
      },
    ];
  }

  private queueAssistantText(message: string): AgentEvent[] {
    // Same dedup rationale as the codex translator: an identical repeat is
    // the same message announced twice, not a new one.
    if (message === this.pendingAssistantText) return [];
    const events = this.pendingAssistantText
      ? [{ type: 'text' as const, delta: `${this.pendingAssistantText}\n\n` }]
      : [];
    this.pendingAssistantText = message;
    return events;
  }

  private prependPendingText(events: AgentEvent[]): AgentEvent[] {
    if (events.length === 0 || !this.pendingAssistantText) return events;
    const pending = this.pendingAssistantText;
    this.pendingAssistantText = undefined;
    return [{ type: 'text', delta: `${pending}\n\n` }, ...events];
  }
}

function parseToolArguments(value: unknown): unknown {
  const raw = stringValue(value);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { raw };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
