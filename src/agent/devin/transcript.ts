import type { AgentEvent } from '../types';
type Tool = { name: string; input?: unknown; output?: unknown; content?: unknown; used: boolean; finished: boolean };

/** Per-prompt ACP state. History replay is deliberately excluded by the caller. */
export class DevinTranscriptTranslator {
  private pending = '';
  private messageId: unknown;
  private terminal = false;
  private readonly tools = new Map<string, Tool>();

  translate(value: unknown, replay = false): AgentEvent[] {
    if (replay || this.terminal) return [];
    const u = record(value);
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const content = record(u.content);
        if (content.type !== 'text' || typeof content.text !== 'string') return [];
        const id = record(u._meta)['cognition.ai/messageId'] ?? u.messageId;
        const events = id !== undefined && this.messageId !== undefined && id !== this.messageId ? this.flush() : [];
        if (id !== undefined) this.messageId = id;
        this.pending += content.text;
        return events;
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
    if (this.terminal) return [];
    if (reason !== 'end_turn' && reason !== 'cancelled') return this.fail(`Devin stopped: ${reason}`);
    this.terminal = true;
    if (reason === 'cancelled') return [...this.flush(), { type: 'done', terminationReason: 'interrupted' }];
    const events: AgentEvent[] = this.pending ? [{ type: 'final_text', content: this.pending }] : [];
    this.pending = '';
    events.push({ type: 'done', terminationReason: 'normal' });
    return events;
  }

  fail(error: unknown): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    const message = error instanceof Error ? error.message : String(error);
    return [...this.flush(), { type: 'error', message: message.slice(0, 4096), terminationReason: 'failed' }];
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  private tool(u: Record<string, unknown>): AgentEvent[] {
    const id = u.toolCallId;
    if (typeof id !== 'string' || !id) return this.fail('Devin tool update has no toolCallId');
    let tool = this.tools.get(id);
    const events: AgentEvent[] = [];
    if (!tool) {
      tool = { name: typeof u.kind === 'string' ? u.kind : 'tool', used: false, finished: false };
      this.tools.set(id, tool);
      events.push(...this.flush());
      this.messageId = undefined;
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
      events.push({ type: 'tool_use', id, name: tool.name, input: tool.input ?? {} });
    }
    if (terminal) {
      tool.finished = true;
      events.push({ type: 'tool_result', id, output: tool.output === undefined ? toolText(tool.content) : stringify(tool.output), isError: u.status === 'failed' });
    }
    return events;
  }

  private flush(): AgentEvent[] {
    const text = this.pending;
    this.pending = '';
    return text ? [{ type: 'text', delta: text.endsWith('\n') ? text : `${text}\n\n` }] : [];
  }
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function stringify(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value) ?? ''; }

function toolText(content: unknown): string {
  if (!Array.isArray(content)) return content === undefined ? '' : stringify(content);
  return content.map(item => {
    const c = record(record(item).content);
    return c.type === 'text' && typeof c.text === 'string' ? c.text : '';
  }).filter(Boolean).join('\n');
}
