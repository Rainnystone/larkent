import type { AgentEvent } from '../types';
import { FinalAnswerCore, type ProtocolDriftState } from '../final-answer/core';
import { isRecord, recordValue, stringValue, truncate } from '../final-answer/values';

export type KimiFinishReason = 'normal' | 'failed' | 'interrupted' | 'timeout';

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
  // D03a: transcripts/kimi/narration-tool-answer.jsonl; last assistant message is the answer.
  private readonly core = new FinalAnswerCore({ accumulation: 'message', preTool: 'progress', separator: 'paragraph' });
  private readonly startedToolCalls = new Map<string, string>();

  translate(raw: unknown): AgentEvent[] {
    if (this.core.terminalEmitted()) return [];
    if (!isRecord(raw) || typeof raw.role !== 'string') {
      this.core.anomaly();
      return [];
    }

    switch (raw.role) {
      case 'meta':
        return this.translateMeta(raw);
      case 'assistant':
        return this.translateAssistant(raw);
      case 'tool':
        return this.translateToolResult(raw);
      default:
        this.core.unknown(raw.role);
        return [];
    }
  }

  finish(reason: KimiFinishReason = 'failed'): AgentEvent[] {
    return reason === 'failed' ? this.fail('kimi stream ended before a terminal event')
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

  private translateMeta(raw: Record<string, unknown>): AgentEvent[] {
    const metaType = stringValue(raw.type);
    switch (metaType) {
      case 'system.version':
        this.version = stringValue(raw.version) ?? this.version;
        return [{ type: 'liveness' }];
      case 'session.resume_hint': {
        const sessionId = stringValue(raw.session_id);
        if (!sessionId) {
          this.core.anomaly();
          return [];
        }
        this.sessionId = sessionId;
        return [{ type: 'system', resumeHandle: sessionId }];
      }
      default:
        this.core.unknown(`meta:${metaType ?? '?'}`);
        return [];
    }
  }

  private translateAssistant(raw: Record<string, unknown>): AgentEvent[] {
    if (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
      return this.translateToolCalls(raw.tool_calls);
    }
    const content = stringValue(raw.content);
    return content ? this.core.accept({ type: 'answer', text: content }) : [];
  }

  private translateToolCalls(toolCalls: unknown[]): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const call of toolCalls) {
      if (!isRecord(call)) {
        this.core.anomaly();
        continue;
      }
      const id = stringValue(call.id);
      const fn = recordValue(call.function);
      const name = fn ? stringValue(fn.name) : undefined;
      if (!id || !name) {
        this.core.anomaly();
        continue;
      }
      this.startedToolCalls.set(id, name);
      events.push(...this.core.accept({ type: 'boundary', toolId: id }), ...this.core.accept({
        type: 'tool_use',
        id,
        name,
        input: parseToolArguments(fn?.arguments),
      }));
    }
    return events;
  }

  private translateToolResult(raw: Record<string, unknown>): AgentEvent[] {
    const id = stringValue(raw.tool_call_id);
    if (!id) {
      this.core.anomaly();
      return [];
    }
    const name = this.startedToolCalls.get(id);
    this.startedToolCalls.delete(id);
    const output = toolOutputText(raw.content);
    // Kimi's shell status is the leading system part (0.38 and current
    // soul/message.py), separate from the command's arbitrary stdout data.
    const failedExit = /^<system>(?:ERROR: )?Command failed with exit code: (-?\d+)\.<\/system>/.exec(output);
    return [...this.core.accept({ type: 'boundary' }), ...this.core.accept(
      {
        type: 'tool_result',
        id,
        output,
        isError: /^(?:Bash|Shell)$/i.test(name ?? '') && failedExit !== null && Number(failedExit[1]) !== 0,
      },
    )];
  }

}

function toolOutputText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n');
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
