import type { AgentEvent } from '../types';
import { log } from '../../core/logger';

export type CursorFinishReason = 'normal' | 'failed' | 'interrupted' | 'timeout';

export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

/**
 * Translates Cursor CLI `agent -p --output-format stream-json` NDJSON into
 * bridge AgentEvents. Documented line shapes:
 *
 *   {"type":"system","subtype":"init","session_id":"...","cwd":"...","model":"..."}
 *   {"type":"user","message":{...},"session_id":"..."}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *   {"type":"tool_call","subtype":"started","call_id":"...","tool_call":{"readToolCall":{...}}}
 *   {"type":"tool_call","subtype":"completed","call_id":"...","tool_call":{...}}
 *   {"type":"result","subtype":"success","result":"...","session_id":"..."}
 *
 * Intermediate assistant texts are forwarded as `text` deltas; the last one
 * is held back as `final_text`. `result.result` concatenates every assistant
 * segment without separators, so it is never used as the reply body.
 */
export class CursorJsonlTranslator {
  private sessionId: string | undefined;
  private cwd: string | undefined;
  private model: string | undefined;
  private terminal = false;
  private pendingAssistantText: string | undefined;
  private readonly startedToolCalls = new Set<string>();
  private drift: ProtocolDriftState = {
    unknownEvents: 0,
    anomalies: 0,
  };

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      this.drift.anomalies++;
      return [];
    }

    switch (raw.type) {
      case 'system':
        return this.translateSystem(raw);
      case 'user':
        return [];
      case 'assistant':
        return this.translateAssistant(raw);
      case 'tool_call':
        return this.prependPendingText(this.translateToolCall(raw));
      case 'result':
        return this.translateResult(raw);
      default:
        this.drift.unknownEvents++;
        log.warn('jsonl', 'unknown_event', { eventType: raw.type });
        return [];
    }
  }

  finish(reason: CursorFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      return this.prependPendingText([
        {
          type: 'error',
          message: 'cursor stream ended before a terminal event',
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
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
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

  private translateSystem(raw: Record<string, unknown>): AgentEvent[] {
    const subtype = stringValue(raw.subtype);
    if (subtype && subtype !== 'init') {
      this.drift.unknownEvents++;
      log.warn('jsonl', 'unknown_event', { eventType: `system:${subtype}` });
      return [];
    }
    const sessionId = stringValue(raw.session_id);
    if (sessionId) this.sessionId = sessionId;
    this.cwd = stringValue(raw.cwd) ?? this.cwd;
    this.model = stringValue(raw.model) ?? this.model;
    return [
      {
        type: 'system',
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        ...(this.cwd ? { cwd: this.cwd } : {}),
        ...(this.model ? { model: this.model } : {}),
      },
    ];
  }

  private translateAssistant(raw: Record<string, unknown>): AgentEvent[] {
    const text = assistantText(raw);
    return text ? this.queueAssistantText(text) : [];
  }

  private translateToolCall(raw: Record<string, unknown>): AgentEvent[] {
    const subtype = stringValue(raw.subtype);
    const id = stringValue(raw.call_id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    if (subtype === 'started') {
      const parsed = parseToolCall(raw.tool_call);
      if (!parsed) {
        this.drift.anomalies++;
        return [];
      }
      this.startedToolCalls.add(id);
      return [{ type: 'tool_use', id, name: parsed.name, input: parsed.input }];
    }
    if (subtype === 'completed') {
      if (!this.startedToolCalls.has(id)) this.drift.anomalies++;
      this.startedToolCalls.delete(id);
      const parsed = parseToolCall(raw.tool_call);
      return [
        {
          type: 'tool_result',
          id,
          output: parsed?.output ?? '',
          isError: parsed?.isError === true,
        },
      ];
    }
    this.drift.unknownEvents++;
    log.warn('jsonl', 'unknown_event', { eventType: `tool_call:${subtype ?? '?'}` });
    return [];
  }

  private translateResult(raw: Record<string, unknown>): AgentEvent[] {
    const sessionId = stringValue(raw.session_id);
    if (sessionId) this.sessionId = sessionId;
    if (raw.is_error === true || stringValue(raw.subtype) === 'error') {
      const message =
        stringValue(raw.result) || stringValue(raw.error) || 'cursor result reported an error';
      return this.fail(message);
    }
    return this.finish('normal');
  }

  private queueAssistantText(message: string): AgentEvent[] {
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

function assistantText(raw: Record<string, unknown>): string | undefined {
  const message = recordValue(raw.message);
  const content = message?.content;
  if (!Array.isArray(content)) return stringValue(raw.result);
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join('') : undefined;
}

function parseToolCall(
  value: unknown,
): { name: string; input: unknown; output?: string; isError?: boolean } | undefined {
  const toolCall = recordValue(value);
  if (!toolCall) return undefined;

  const fn = recordValue(toolCall.function);
  if (fn) {
    const name = stringValue(fn.name);
    if (!name) return undefined;
    const result = recordValue(fn.result);
    return {
      name,
      input: parseToolArguments(fn.arguments ?? fn.args),
      ...toolResultFields(result),
    };
  }

  for (const [key, payload] of Object.entries(toolCall)) {
    if (!key.endsWith('ToolCall') && !key.endsWith('Call')) continue;
    const body = recordValue(payload);
    if (!body) continue;
    const name = toolCallName(key);
    const result = recordValue(body.result);
    return {
      name,
      input: body.args ?? {},
      ...toolResultFields(result),
    };
  }
  return undefined;
}

function toolCallName(key: string): string {
  const stripped = key.replace(/ToolCall$/, '').replace(/Call$/, '');
  if (!stripped) return key;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function toolResultFields(
  result: Record<string, unknown> | undefined,
): { output?: string; isError?: boolean } {
  if (!result) return {};
  if (isRecord(result.error) || typeof result.error === 'string') {
    return {
      output:
        typeof result.error === 'string'
          ? result.error
          : JSON.stringify(result.error),
      isError: true,
    };
  }
  if (isRecord(result.success)) {
    return { output: stringifyToolOutput(result.success), isError: false };
  }
  if (result.success !== undefined) {
    return { output: stringifyToolOutput(result.success), isError: false };
  }
  return { output: stringifyToolOutput(result), isError: false };
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseToolArguments(value: unknown): unknown {
  if (value && typeof value === 'object') return value;
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
