import type { AgentEvent } from '../types';
import { FinalAnswerCore, type ProtocolDriftState } from '../final-answer/core';
import { isRecord, nonEmptyString as stringValue, finiteNumber as numberValue, truncate } from '../final-answer/values';
import { stripTerminalText } from '../terminal-text';
import { isShellTool } from '../shell-tool';

export type GrokFinishReason = 'normal' | 'failed' | 'interrupted' | 'timeout';

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
 * Each non-empty chunk also emits a `liveness` event so the idle
 * watchdog stays armed while that answer is held back. Text that arrived
 * before a tool call is emitted as a progress `text` delta and is not part of
 * the answer; if no text follows the last tool, the last non-empty pre-tool
 * segment becomes the answer. `thought` lines become `thinking` deltas and
 * are not part of that answer.
 */
export class GrokJsonlTranslator {
  private sessionId: string | undefined;
  // D03a: transcripts/grok/narration-tool-answer.jsonl has deltas around tools;
  // The legacy fallback is pinned by D03b synthetic boundaries; D03a does not exercise missing post-tool text.
  private readonly core = new FinalAnswerCore({ accumulation: 'delta', preTool: 'fallback', separator: 'line', clean: stripTerminalText, hasAnswer: hasAnswerText });
  private readonly startedToolCalls = new Map<string, string>();
  private lastUsage: AgentEvent | undefined;

  translate(raw: unknown): AgentEvent[] {
    if (this.core.terminalEmitted()) return [];
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      this.core.anomaly();
      return [];
    }

    switch (raw.type) {
      case 'thought': {
        const delta = stringValue(raw.data) ?? stringValue(raw.text);
        if (!delta) return [];
        return [{ type: 'thinking', delta }];
      }
      case 'text': {
        const text = stringValue(raw.data) ?? stringValue(raw.text);
        return text ? this.core.accept({ type: 'answer', text }) : [];
      }
      case 'tool_call':
        return [...this.core.accept({ type: 'boundary' }), ...this.translateToolCall(raw)];
      case 'tool_call_update':
        return this.translateToolCallUpdate(raw);
      case 'usage':
        this.rememberUsage(raw);
        return [];
      case 'end':
        return this.translateEnd(raw);
      case 'error':
        return this.translateError(raw);
      case 'plan':
      case 'available_commands':
        return [];
      default:
        this.core.unknown(raw.type);
        return [];
    }
  }

  finish(reason: GrokFinishReason = 'failed'): AgentEvent[] {
    return reason === 'failed' ? this.fail('grok stream ended before a terminal event')
      : this.core.accept({ type: 'complete', terminal: this.doneEvent(reason), prefix: this.takeUsage() });
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

  private translateToolCall(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.toolCallId) ?? stringValue(raw.id);
    const name = stringValue(raw.toolName) ?? stringValue(raw.name) ?? stringValue(raw.title);
    if (!id || !name) {
      this.core.anomaly();
      return [];
    }
    const events: AgentEvent[] = [];
    if (!this.startedToolCalls.has(id)) {
      this.startedToolCalls.set(id, name);
      events.push(...this.core.accept({
        type: 'tool_use',
        id,
        name,
        input: raw.rawInput ?? raw.input ?? {},
      }));
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
      this.core.anomaly();
      return [];
    }
    const status = stringValue(raw.status);
    if (status === 'in_progress' || status === 'pending') return [{ type: 'liveness' }];
    const finished = status === 'completed' || status === 'failed' || status === 'error';
    // Grok 1.0.41 sends a statusless metadata update (kind/title/rawInput, no
    // rawOutput) before `completed`. Missing status is a result only when that
    // update itself carries rawOutput (older builds that omit status entirely).
    this.refineStartedTool(id, raw);
    if (!finished && !(status === undefined && raw.rawOutput != null)) return [{ type: 'liveness' }];
    return this.toolResult(id, raw, status === 'failed' || status === 'error');
  }

  /** Keep the shell tool name. A progress title like `Execute \`ls …\`` is not one. */
  private refineStartedTool(id: string, raw: Record<string, unknown>): void {
    const current = this.startedToolCalls.get(id);
    if (current === undefined) return;
    const next = explicitToolName(raw);
    if (!next || next === current) return;
    if (isShellTool(current) && !isShellTool(next)) return;
    this.startedToolCalls.set(id, next);
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
    return this.core.accept(
      {
        type: 'tool_result',
        id,
        output: serializeToolOutput(output),
        isError: isError || (exitCode !== undefined && exitCode !== 0),
      },
    );
  }

  private rememberUsage(raw: Record<string, unknown>): void {
    const usage = this.usageEvent(raw);
    if (usage) this.lastUsage = usage;
  }

  private takeUsage(): AgentEvent[] {
    const usage = this.lastUsage;
    this.lastUsage = undefined;
    return usage ? [usage] : [];
  }

  private translateEnd(raw: Record<string, unknown>): AgentEvent[] {
    if (this.core.terminalEmitted()) return [];
    const sessionId = stringValue(raw.sessionId) ?? stringValue(raw.session_id);
    if (sessionId) this.sessionId = sessionId;
    const events: AgentEvent[] = [];
    if (sessionId) events.push({ type: 'system', resumeHandle: sessionId });
    this.rememberUsage(raw);
    events.push(...this.takeUsage());
    return this.core.accept({ type: 'complete', terminal: this.doneEvent('normal'), prefix: events });
  }

  private translateError(raw: Record<string, unknown>): AgentEvent[] {
    if (this.core.terminalEmitted()) return [];
    const message = stringValue(raw.message) ?? stringValue(raw.error) ?? 'grok reported an error';
    return this.fail(message);
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
      numberValue(usage.total_cost_usd) ??
      numberValue(usage.cost_usd) ??
      numberValue(usage.costUsd) ??
      numberValue(usage.cost);
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

  private doneEvent(reason: 'normal' | 'interrupted' | 'timeout'): Extract<AgentEvent, { type: 'done' }> {
    return {
      type: 'done',
      ...(this.sessionId ? { resumeHandle: this.sessionId } : {}),
      terminationReason: reason,
    };
  }

}

/** A buffer that is only a Grok control token, such as `<|eos|>`, is not an answer. */
function isControlTokenOnly(value: string): boolean {
  return /^<\|[a-z_]+\|>$/.test(value.trim());
}

function hasAnswerText(value: string): boolean {
  return value.trim() !== '' && !isControlTokenOnly(value);
}

const UTF8_DECODER = new TextDecoder('utf-8');

function serializeToolOutput(value: unknown): string {
  if (value === undefined || value === null) return '';
  const readFile = readFileContent(value);
  if (readFile !== undefined) return stripAnsi(readFile);
  if (typeof value === 'string') return stripAnsi(value);
  const decoded = decodeUtf8Bytes(value);
  if (decoded !== undefined) return stripAnsi(decoded);
  if (isRecord(value) && !Array.isArray(value) && !(value instanceof Uint8Array)) {
    const wrapped = decodeUtf8Bytes(value.output) ?? decodeUtf8Bytes(value.content);
    if (wrapped !== undefined) return stripAnsi(wrapped);
  }
  try {
    // Clean native strings before JSON escaping would turn ESC into visible
    // "\u001b" text that the card renderer can no longer recognize as ANSI.
    return JSON.stringify(value, (_key, part) => typeof part === 'string' ? stripAnsi(part) : part);
  } catch {
    return stripAnsi(String(value));
  }
}

function stripAnsi(value: string): string {
  // Tool text, including the Node NO_COLOR warning Grok injects itself,
  // plus ANSI, BEL, and `\r` progress overwrites.
  return stripTerminalText(value);
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

function readFileContent(value: unknown): string | undefined {
  if (!isRecord(value) || value.type !== 'ReadFile') return undefined;
  const file = value.FileContent;
  if (!isRecord(file) || typeof file.content !== 'string') return undefined;
  return file.content;
}

function explicitToolName(raw: Record<string, unknown>): string | undefined {
  const meta = isRecord(raw._meta) ? raw._meta['x.ai/tool'] : undefined;
  const metaName = isRecord(meta) ? stringValue(meta.name) : undefined;
  return stringValue(raw.toolName) ?? stringValue(raw.name) ?? metaName;
}
