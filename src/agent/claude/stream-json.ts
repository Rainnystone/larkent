import type { AgentEvent } from '../types';

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
  is_error?: boolean;
  errors?: unknown;
  result?: string;
}

/** Per-run state for EOF, interruption and protocol errors. */
export class ClaudeStreamTranslator {
  private handle: string | undefined;
  private terminal: 'done' | 'error' | undefined;

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) return [];
    const events = [...translateEvent(raw)];
    for (const event of events) {
      if ('resumeHandle' in event && event.resumeHandle) this.handle = event.resumeHandle;
      if (event.type === 'done' || event.type === 'error') this.terminal = event.type;
    }
    return events;
  }

  finish(reason?: string): AgentEvent[] {
    if (this.terminal) return [];
    if (reason === 'interrupted' || reason === 'timeout') {
      this.terminal = 'done';
      return [{ type: 'done', resumeHandle: this.handle, terminationReason: reason }];
    }
    return this.fail('claude stream ended before a result event');
  }

  fail(message: string): AgentEvent[] {
    // An error result is already authoritative, even if the CLI then exits 1.
    // Preserve the existing nonzero-tail diagnostic after a success result.
    if (this.terminal === 'error') return [];
    this.terminal = 'error';
    return [{ type: 'error', message, terminationReason: 'failed' }];
  }

  terminalEmitted(): boolean {
    return this.terminal !== undefined;
  }
}

export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as ClaudeRawEvent;

  if (evt.type === 'system' && evt.subtype === 'init') {
    yield {
      type: 'system',
      resumeHandle: evt.session_id,
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
    if (evt.is_error === true || (typeof evt.subtype === 'string' && evt.subtype.startsWith('error_'))) {
      const details = Array.isArray(evt.errors)
        ? evt.errors.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [];
      const message = details.join('\n') || evt.result || `claude result: ${evt.subtype ?? 'error'}`;
      yield { type: 'error', message: message.slice(0, 4096), terminationReason: 'failed' };
    } else {
      yield { type: 'done', resumeHandle: evt.session_id, terminationReason: 'normal' };
    }
  }
}
