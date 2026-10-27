import type { AgentEvent } from '../types';
import { FinalAnswerCore } from '../final-answer/core';
import { record, isRecord } from '../final-answer/values';
type Tool = { name: string; input?: unknown; output?: unknown; content?: unknown; used: boolean; finished: boolean };

/** Per-prompt ACP state. History replay is deliberately excluded by the caller. */
export class DevinTranscriptTranslator {
  // D03a: transcripts/devin/narration-tool-answer.jsonl: message chunks surround tool updates.
  private readonly core = new FinalAnswerCore({ accumulation: 'delta', preTool: 'progress', separator: 'line' });
  private readonly tools = new Map<string, Tool>();

  translate(value: unknown, replay = false): AgentEvent[] {
    if (replay || this.core.terminalEmitted()) return [];
    const u = record(value);
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const content = record(u.content);
        if (content.type !== 'text' || typeof content.text !== 'string') return [];
        const id = record(u._meta)['cognition.ai/messageId'] ?? u.messageId;
        return this.core.accept({ type: 'answer', text: content.text, messageId: id });
      }
      case 'agent_thought_chunk': {
        const c = record(u.content);
        return c.type === 'text' && typeof c.text === 'string' ? [{ type: 'thinking', delta: c.text }] : [];
      }
      case 'tool_call':
      case 'tool_call_update':
        return this.tool(u);
      default:
        return [];
    }
  }

  finish(reason = 'end_turn'): AgentEvent[] {
    if (this.core.terminalEmitted()) return [];
    if (reason !== 'end_turn' && reason !== 'cancelled') return this.fail(`Devin stopped: ${reason}`);
    return this.core.accept({ type: 'done', terminationReason: reason === 'cancelled' ? 'interrupted' : 'normal' });
  }

  fail(error: unknown): AgentEvent[] {
    const message = error instanceof Error ? error.message : String(error);
    return this.core.accept({ type: 'error', message: message.slice(0, 4096), terminationReason: 'failed' });
  }

  terminalEmitted(): boolean {
    return this.core.terminalEmitted();
  }

  private tool(u: Record<string, unknown>): AgentEvent[] {
    const id = u.toolCallId;
    if (typeof id !== 'string' || !id) return this.fail('Devin tool update has no toolCallId');
    let tool = this.tools.get(id);
    const events: AgentEvent[] = [];
    if (!tool) {
      tool = { name: typeof u.kind === 'string' ? u.kind : 'tool', used: false, finished: false };
      this.tools.set(id, tool);
      events.push(...this.core.accept({ type: 'boundary' }));
    }
    if (tool.finished) return [];
    if (typeof u.kind === 'string') tool.name = u.kind;
    if (u.rawInput != null) {
      tool.input = isRecord(tool.input) && isRecord(u.rawInput) ? { ...tool.input, ...u.rawInput } : u.rawInput;
      if (tool.name === 'execute' && isRecord(tool.input) && !tool.input.command && Array.isArray(tool.input.argv)) {
        tool.input = { ...tool.input, command: tool.input.argv };
      }
    }
    if (u.rawOutput != null) tool.output = u.rawOutput;
    if (u.content != null) tool.content = u.content;
    const terminal = u.status === 'completed' || u.status === 'failed';
    const command = record(tool.input).command ?? record(tool.input).cmd ?? tool.input;
    const inputReady = tool.name !== 'execute'
      || (typeof command === 'string' && command.trim().length > 0)
      || (Array.isArray(command) && command.length > 0 && command.every(v => typeof v === 'string') && Boolean(command[0]));
    if (!tool.used && ((tool.input !== undefined && inputReady) || terminal)) {
      tool.used = true;
      events.push(...this.core.accept({ type: 'tool_use', id, name: tool.name, input: tool.input ?? {} }));
    }
    if (terminal) {
      tool.finished = true;
      events.push(...this.core.accept({ type: 'tool_result', id, output: tool.output === undefined ? toolText(tool.content) : stringify(tool.output), isError: u.status === 'failed' }));
    }
    return events.length ? events : [{ type: 'liveness' }];
  }

}

function stringify(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value) ?? ''; }

function toolText(content: unknown): string {
  if (!Array.isArray(content)) return content === undefined ? '' : stringify(content);
  return content.map(item => {
    const c = record(record(item).content);
    return c.type === 'text' && typeof c.text === 'string' ? c.text : '';
  }).filter(Boolean).join('\n');
}
