import type { AgentEvent } from '../types';
import {
  jsonlFailDisposition,
  parseJsonlLine,
  truncateJsonlMessage,
  type JsonlTranslator,
} from '../runner/jsonl-translator';

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeRawEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  message?: { content?: ContentBlock[] };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
}

export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as ClaudeRawEvent;

  if (evt.type === 'system' && evt.subtype === 'init') {
    yield {
      type: 'system',
      sessionId: evt.session_id,
      cwd: evt.cwd,
      model: evt.model,
    };
    return;
  }

  if (evt.type === 'assistant' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        yield { type: 'text', delta: block.text };
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        yield { type: 'thinking', delta: block.thinking };
      } else if (block.type === 'tool_use' && block.id && block.name) {
        yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      }
    }
    return;
  }

  if (evt.type === 'user' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const output =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        yield {
          type: 'tool_result',
          id: block.tool_use_id,
          output,
          isError: block.is_error === true,
        };
      }
    }
    return;
  }

  if (evt.type === 'result') {
    if (evt.usage) {
      yield {
        type: 'usage',
        inputTokens: evt.usage.input_tokens,
        outputTokens: evt.usage.output_tokens,
        cachedInputTokens: evt.usage.cache_read_input_tokens,
        costUsd: evt.total_cost_usd,
      };
    }
    yield { type: 'done', sessionId: evt.session_id, terminationReason: 'normal' };
  }
}

export class ClaudeJsonlTranslator implements JsonlTranslator {
  private terminal = false;
  private sessionId: string | undefined;

  translate(line: string): AgentEvent[] {
    const parsed = parseJsonlLine(line);
    if (parsed === undefined) return [];
    const events = [...translateEvent(parsed)];
    for (const event of events) {
      if (event.type === 'system' && event.sessionId) this.sessionId = event.sessionId;
      if (event.type === 'done' || event.type === 'error') this.terminal = true;
    }
    return events;
  }

  finish(reason: 'interrupted' | 'timeout' | 'failed' = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    if (reason === 'interrupted' || reason === 'timeout') {
      this.terminal = true;
      return [
        {
          type: 'done',
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
          terminationReason: reason,
        },
      ];
    }
    return [];
  }

  fail(error: unknown): AgentEvent[] {
    if (this.terminal) return [];
    const disposition = jsonlFailDisposition(error);
    if (disposition.mode === 'stop') return this.finish('interrupted');
    this.terminal = true;
    return [
      {
        type: 'error',
        message: truncateJsonlMessage(disposition.message),
        terminationReason: disposition.terminationReason,
      },
    ];
  }
}
