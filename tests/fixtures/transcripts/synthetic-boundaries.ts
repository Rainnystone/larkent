import type { ReplayCase, ReplayKind, ReplayStep } from '../../helpers/transcript-replay';

// These are deliberately constructed from existing unit-test record shapes.
// They characterize translator edges; they are not evidence of CLI behaviour.
const messages: Record<ReplayKind, unknown> = {
  claude: { type: 'assistant', message: { content: [{ type: 'text', text: 'Narration.' }] } },
  codex: { type: 'agent_message', message: 'Narration.' },
  kimi: { role: 'assistant', content: 'Narration.' },
  grok: { type: 'text', data: 'Narration.' },
  cursor: { type: 'assistant', message: { content: [{ type: 'text', text: 'Narration.' }] } },
  antigravity: { event: 'step_update', step_update: { step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Narration.' } },
  devin: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Narration.' }, messageId: 'message-1' },
};
const tools: Record<ReplayKind, unknown> = {
  claude: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'README.md' } }] } },
  codex: { type: 'item.started', item: { id: 'tool-1', type: 'command_execution', command: 'pwd' } },
  kimi: { role: 'assistant', tool_calls: [{ type: 'function', id: 'tool-1', function: { name: 'Read', arguments: '{"path":"README.md"}' } }] },
  grok: { type: 'tool_call', toolCallId: 'tool-1', toolName: 'ReadFile', status: 'in_progress', rawInput: { path: 'README.md' } },
  cursor: { type: 'tool_call', subtype: 'started', call_id: 'tool-1', tool_call: { readToolCall: { args: { path: 'README.md' } } } },
  antigravity: { event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { path: 'README.md' } } } },
  devin: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', kind: 'read', rawInput: { path: 'README.md' } },
};
const end: Record<ReplayKind, ReplayStep> = {
  claude: { method: 'translate', args: [{ type: 'result', subtype: 'success' }] },
  codex: { method: 'translate', args: [{ type: 'turn.completed' }] },
  kimi: { method: 'finish', args: ['normal'] },
  grok: { method: 'translate', args: [{ type: 'end', stopReason: 'end_turn' }] },
  cursor: { method: 'translate', args: [{ type: 'result', subtype: 'success', is_error: false }] },
  antigravity: { method: 'translate', args: [{ event: 'result', result: { status: 'SUCCESS' } }] },
  devin: { method: 'finish', args: ['end_turn'] },
};

export function syntheticBoundaries(kind: ReplayKind): ReplayCase[] {
  const text: ReplayStep = { method: 'translate', args: [messages[kind]] };
  const tool: ReplayStep = { method: 'translate', args: [tools[kind]] };
  const sequences: Record<string, ReplayStep[]> = {
    'empty answer': [end[kind]],
    'narration only before EOF': [text, { method: 'finish', args: [] }],
    'tool without result': [text, tool, end[kind]],
    'repeated message': [text, text, end[kind]],
    'error after text': [text, { method: 'fail', args: ['synthetic connection lost'] }],
    'interrupted after text': [text, { method: 'finish', args: [kind === 'devin' ? 'cancelled' : 'interrupted'] }],
    'late text and repeated terminal': [text, end[kind], text, end[kind], { method: 'fail', args: ['synthetic late error'] }],
  };
  return Object.entries(sequences).map(([name, steps]) => ({ kind, name, source: 'synthetic (existing unit-test shapes)', steps }));
}
