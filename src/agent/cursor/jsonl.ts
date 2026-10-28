import type { AgentEvent } from '../types';
import { FinalAnswerCore, type ProtocolDriftState } from '../final-answer/core';
import { isRecord, recordValue, stringValue, truncate } from '../final-answer/values';
import { isShellTool } from '../shell-tool';
import { log } from '../../core/logger';

export type CursorFinishReason = 'normal' | 'failed' | 'interrupted' | 'timeout';

/**
 * Translates Cursor CLI `agent -p --output-format stream-json` NDJSON into
 * bridge AgentEvents. Documented line shapes:
 *
 *   {"type":"system","subtype":"init","session_id":"...","cwd":"...","model":"..."}
 *   {"type":"user","message":{...},"session_id":"..."}
 *   {"type":"thinking",...}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *   {"type":"tool_call","subtype":"started","call_id":"...","tool_call":{"readToolCall":{...}}}
 *   {"type":"tool_call","subtype":"completed","call_id":"...","tool_call":{...}}
 *   {"type":"result","subtype":"success","result":"...","session_id":"..."}
 *
 * Intermediate assistant texts are held back; the last one is emitted as
 * `final_text`. On `tool_call`, pending assistant text is discarded so
 * pre-tool plan monologues never reach Feishu. `result.result` concatenates
 * every assistant segment without separators, so it is never used as the
 * reply body.
 */
export class CursorJsonlTranslator {
  private sessionId: string | undefined;
  private cwd: string | undefined;
  private model: string | undefined;
  // D03a: transcripts/cursor/narration-tool-answer.jsonl: result concatenates narration and answer.
  private readonly core = new FinalAnswerCore({ accumulation: 'message', preTool: 'discard', separator: 'paragraph' });

  translate(raw: unknown): AgentEvent[] {
    if (this.core.terminalEmitted()) return [];
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      this.core.anomaly();
      return [];
    }

    switch (raw.type) {
      case 'system':
        return this.translateSystem(raw);
      case 'user':
        return [];
      case 'thinking':
        return [{ type: 'liveness' }];
      case 'assistant':
        return this.translateAssistant(raw);
      case 'tool_call':
        return [...this.core.accept({ type: 'boundary', ...(raw.subtype === 'started' ? { toolId: stringValue(raw.call_id) } : {}) }), ...this.translateToolCall(raw)];
      case 'result':
        return this.translateResult(raw);
      case 'connection':
      case 'retry':
        log.info('jsonl', 'stream-reconnect', {
          eventType: raw.type,
          ...(typeof raw.attempt === 'number' ? { attempt: raw.attempt } : {}),
          ...(typeof raw.subtype === 'string' ? { subtype: raw.subtype } : {}),
        });
        return [{ type: 'liveness' }];
      default:
        this.core.unknown(raw.type);
        return [];
    }
  }

  finish(reason: CursorFinishReason = 'failed'): AgentEvent[] {
    return reason === 'failed' ? this.fail('cursor stream ended before a terminal event')
      : this.core.accept({ type: 'done', ...(this.sessionId ? { resumeHandle: this.sessionId } : {}), terminationReason: reason });
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

  private translateSystem(raw: Record<string, unknown>): AgentEvent[] {
    const subtype = stringValue(raw.subtype);
    if (subtype && subtype !== 'init') {
      this.core.unknown(`system:${subtype}`);
      return [];
    }
    const sessionId = stringValue(raw.session_id);
    if (sessionId) this.sessionId = sessionId;
    this.cwd = stringValue(raw.cwd) ?? this.cwd;
    this.model = stringValue(raw.model) ?? this.model;
    return this.core.accept(
      {
        type: 'system',
        ...(this.sessionId ? { resumeHandle: this.sessionId } : {}),
        ...(this.cwd ? { cwd: this.cwd } : {}),
        ...(this.model ? { model: this.model } : {}),
      },
    );
  }

  private translateAssistant(raw: Record<string, unknown>): AgentEvent[] {
    const text = assistantText(raw);
    return text ? this.core.accept({ type: 'answer', text }) : [];
  }

  private translateToolCall(raw: Record<string, unknown>): AgentEvent[] {
    const subtype = stringValue(raw.subtype);
    const id = stringValue(raw.call_id);
    if (!id) {
      this.core.anomaly();
      return [];
    }
    if (subtype === 'started') {
      const parsed = parseToolCall(raw.tool_call);
      if (!parsed) {
        this.core.anomaly();
        return [];
      }
      return this.core.accept({ type: 'tool_use', id, name: parsed.name, input: parsed.input });
    }
    if (subtype === 'completed') {
      const parsed = parseToolCall(raw.tool_call);
      return this.core.accept(
        {
          type: 'tool_result',
          id,
          output: parsed?.output ?? '',
          isError: parsed?.isError === true,
        },
      );
    }
    this.core.unknown(`tool_call:${subtype ?? '?'}`);
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
      ...toolResultFields(result, name),
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
      ...toolResultFields(result, name),
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
  name: string,
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
    const failedExit = [result.success.exitCode, result.success.exit_code]
      .some(code => typeof code === 'number' && Number.isInteger(code) && code !== 0);
    return { output: stringifyToolOutput(result.success), isError: isShellTool(name) && failedExit };
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
