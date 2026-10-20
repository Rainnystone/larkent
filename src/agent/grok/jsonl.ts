import { stripVTControlCharacters } from 'node:util';
import type { AgentEvent } from '../types';
import { isShellTool } from '../shell-tool';
import { log } from '../../core/logger';

export type GrokFinishReason = 'normal' | 'failed' | 'interrupted' | 'timeout';

export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

/**
 * Translates `grok -p --output-format streaming-json` NDJSON into bridge
 * AgentEvents. Documented line shapes (Grok Build 1.0.x):
 *
 *   {"type":"thought","data":"..."}
 *   {"type":"tool_call","toolCallId":"call_1","toolName":"read_file","status":"in_progress","rawInput":{...}}
 *   {"type":"tool_call_update","toolCallId":"call_1","status":"completed","rawOutput":{...}}
 *   {"type":"text","data":"..."}
 *   {"type":"usage","usage":{"input_tokens":n,"output_tokens":n,...}}
 *   {"type":"end","stopReason":"end_turn","sessionId":"<uuid>","usage":{...}}
 *   {"type":"error","message":"..."}
 *
 * `text` lines are incremental chunks of the same answer, not complete
 * messages. They are concatenated and held back as `final_text` on `end`
 * (same hold-back as kimi/codex, so showToolCalls:false sends one reply).
 * Pre-tool commentary and `thought` lines are dropped rather than streamed,
 * so Feishu only gets the final answer unless the operator turns tools on.
 */
export class GrokJsonlTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private pendingText = '';
  private readonly startedToolCalls = new Map<string, string>();
  private lastUsage: AgentEvent | undefined;
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
      case 'thought':
        return [];
      case 'text':
        return this.queueText(stringValue(raw.data) ?? stringValue(raw.text));
      case 'tool_call':
        this.pendingText = '';
        return this.translateToolCall(raw);
      case 'tool_call_update':
        return this.translateToolCallUpdate(raw);
      case 'usage':
        return this.translateUsage(raw);
      case 'end':
        return this.translateEnd(raw);
      case 'error':
        return this.translateError(raw);
      case 'plan':
      case 'available_commands':
        return [];
      default:
        this.drift.unknownEvents++;
        log.warn('jsonl', 'unknown_event', { eventType: raw.type });
        return [];
    }
  }

  finish(reason: GrokFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'failed') {
      return this.flushPendingText([
        {
          type: 'error',
          message: 'grok stream ended before a terminal event',
          terminationReason: 'failed',
        },
      ]);
    }
    return [...this.finalTextEvents(), this.doneEvent(reason)];
  }

  fail(message: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return this.flushPendingText([
      { type: 'error', message: truncate(message, 4096), terminationReason: 'failed' },
    ]);
  }

  protocolDrift(): ProtocolDriftState {
    return { ...this.drift };
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private queueText(message: string | undefined): AgentEvent[] {
    if (!message) return [];
    this.pendingText += message;
    return [];
  }

  private translateToolCall(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.toolCallId) ?? stringValue(raw.id);
    const name = stringValue(raw.toolName) ?? stringValue(raw.name) ?? stringValue(raw.title);
    if (!id || !name) {
      this.drift.anomalies++;
      return [];
    }
    const events: AgentEvent[] = [];
    if (!this.startedToolCalls.has(id)) {
      this.startedToolCalls.set(id, name);
      events.push({
        type: 'tool_use',
        id,
        name,
        input: raw.rawInput ?? raw.input ?? {},
      });
    }
    const status = stringValue(raw.status);
    if (status === 'completed' || status === 'failed' || status === 'error') {
      events.push(...this.toolResult(id, raw, status !== 'completed'));
    }
    return events;
  }

  private translateToolCallUpdate(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.toolCallId) ?? stringValue(raw.id);
    if (!id) {
      this.drift.anomalies++;
      return [];
    }
    const status = stringValue(raw.status);
    if (status === 'in_progress' || status === 'pending') return [];
    if (status === 'completed' || status === 'failed' || status === 'error' || status === undefined) {
      if (!this.startedToolCalls.has(id)) this.drift.anomalies++;
      return this.toolResult(id, raw, status === 'failed' || status === 'error');
    }
    return [];
  }

  private toolResult(
    id: string,
    raw: Record<string, unknown>,
    isError: boolean,
  ): AgentEvent[] {
    const name = this.startedToolCalls.get(id);
    this.startedToolCalls.delete(id);
    const output = raw.rawOutput ?? raw.content ?? raw.output;
    // "completed" describes the tool lifecycle; a shell process may still fail.
    const exitCode = isShellTool(name) && isRecord(output)
      ? numberValue(output.exitCode) ?? numberValue(output.exit_code)
      : undefined;
    return [
      {
        type: 'tool_result',
        id,
        output: serializeToolOutput(output),
        isError: isError || (exitCode !== undefined && exitCode !== 0),
      },
    ];
  }

  private translateUsage(raw: Record<string, unknown>): AgentEvent[] {
    const usage = this.usageEvent(raw);
    if (!usage) return [];
    this.lastUsage = usage;
    return [usage];
  }

  private translateEnd(raw: Record<string, unknown>): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    const sessionId = stringValue(raw.sessionId) ?? stringValue(raw.session_id);
    if (sessionId) this.sessionId = sessionId;
    const events: AgentEvent[] = [];
    if (sessionId) events.push({ type: 'system', resumeHandle: sessionId });
    const usage = this.usageEvent(raw);
    if (usage && !sameUsage(usage, this.lastUsage)) events.push(usage);
    events.push(...this.finalTextEvents());
    events.push(this.doneEvent('normal'));
    return events;
  }

  private translateError(raw: Record<string, unknown>): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    const message = stringValue(raw.message) ?? stringValue(raw.error) ?? 'grok reported an error';
    return this.flushPendingText([
      { type: 'error', message: truncate(message, 4096), terminationReason: 'failed' },
    ]);
  }

  private usageEvent(raw: Record<string, unknown>): AgentEvent | undefined {
    const usage = isRecord(raw.usage) ? raw.usage : raw;
    const inputTokens = numberValue(usage.input_tokens) ?? numberValue(usage.inputTokens);
    const outputTokens = numberValue(usage.output_tokens) ?? numberValue(usage.outputTokens);
    const cachedInputTokens =
      numberValue(usage.cache_read_input_tokens) ?? numberValue(usage.cacheReadInputTokens);
    const reasoningOutputTokens =
      numberValue(usage.reasoning_tokens) ?? numberValue(usage.reasoningOutputTokens);
    const costUsd =
      numberValue(raw.total_cost_usd) ??
      numberValue(usage.cost_usd) ??
      numberValue(usage.costUsd);
    if (
      inputTokens === undefined &&
      outputTokens === undefined &&
      cachedInputTokens === undefined &&
      reasoningOutputTokens === undefined &&
      costUsd === undefined
    ) {
      return undefined;
    }
    return {
      type: 'usage',
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
  }

  private finalTextEvents(): AgentEvent[] {
    const content = this.pendingText;
    this.pendingText = '';
    if (!content || isControlTokenOnly(content)) return [];
    return [{ type: 'final_text', content }];
  }

  private doneEvent(reason: 'normal' | 'interrupted' | 'timeout'): AgentEvent {
    return {
      type: 'done',
      ...(this.sessionId ? { resumeHandle: this.sessionId } : {}),
      terminationReason: reason,
    };
  }

  private flushPendingText(events: AgentEvent[]): AgentEvent[] {
    if (events.length === 0 || !this.pendingText) return events;
    const pending = this.pendingText;
    this.pendingText = '';
    if (isControlTokenOnly(pending)) return events;
    return [{ type: 'text', delta: pending.endsWith('\n') ? pending : `${pending}\n\n` }, ...events];
  }
}

/** A buffer that is only a Grok control token, such as `<|eos|>`, is not an answer. */
function isControlTokenOnly(value: string): boolean {
  return /^<\|[a-z_]+\|>$/.test(value.trim());
}

const UTF8_DECODER = new TextDecoder('utf-8');

function serializeToolOutput(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  const decoded = decodeUtf8Bytes(value);
  if (decoded !== undefined) return decoded;
  if (isRecord(value) && !Array.isArray(value) && !(value instanceof Uint8Array)) {
    const wrapped = decodeUtf8Bytes(value.output) ?? decodeUtf8Bytes(value.content);
    if (wrapped !== undefined) return wrapped;
  }
  try {
    // Clean native strings before JSON escaping would turn ESC into visible
    // "\u001b" text that the card renderer can no longer recognize as ANSI.
    return JSON.stringify(value, (_key, part) => typeof part === 'string' ? stripVTControlCharacters(part) : part);
  } catch {
    return String(value);
  }
}

function decodeUtf8Bytes(value: unknown): string | undefined {
  const bytes = asUtf8Bytes(value);
  if (!bytes) return undefined;
  return UTF8_DECODER.decode(bytes);
}

function asUtf8Bytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const n = value[i];
    if (!isByteInt(n)) return undefined;
    bytes[i] = n;
  }
  return bytes;
}

function isByteInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
}

function sameUsage(a: AgentEvent, b: AgentEvent | undefined): boolean {
  return Boolean(b && JSON.stringify(a) === JSON.stringify(b));
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
