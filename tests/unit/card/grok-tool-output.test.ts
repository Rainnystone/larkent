import { describe, expect, it } from 'vitest';
import { GrokJsonlTranslator } from '../../../src/agent/grok/jsonl';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState, reduce } from '../../../src/card/run-state';
import { toolBodyMd } from '../../../src/card/tool-render';

/** Worked example: UTF-8 of `中文{"ok":true}` as Grok sends it on the wire. */
const BASH_UTF8_TEXT = '中文{"ok":true}';
const BASH_UTF8_BYTES = [228, 184, 173, 230, 150, 135, 123, 34, 111, 107, 34, 58, 116, 114, 117, 101, 125];
const WIRE_BYTES_JSON = '[228,184,173,230,150,135,123,34,111,107,34,58,116,114,117,101,125]';

describe('Grok tool progress card', () => {
  it('renders Bash byte-array output as readable utf-8 text', () => {
    const translator = new GrokJsonlTranslator();
    const events = [
      ...translator.translate({
        type: 'tool_call',
        toolCallId: 'call_1',
        toolName: 'Bash',
        status: 'in_progress',
        rawInput: { command: 'bridge-tool' },
      }),
      ...translator.translate({
        type: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'completed',
        rawOutput: { type: 'Bash', output: BASH_UTF8_BYTES },
      }),
    ];
    const state = events.reduce((next, event) => reduce(next, event), initialState);
    const toolBlock = state.blocks.find((block) => block.kind === 'tool');
    expect(toolBlock?.kind).toBe('tool');
    if (toolBlock?.kind !== 'tool') return;
    const cardText = markdownContents(renderCard(state)).join('\n');
    const body = toolBodyMd(toolBlock.tool);

    expect(body).toContain(BASH_UTF8_TEXT);
    expect(body).not.toContain(WIRE_BYTES_JSON);
    expect(cardText).toContain(BASH_UTF8_TEXT);
    expect(cardText).not.toContain(WIRE_BYTES_JSON);
  });
});

function markdownContents(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(markdownContents);
  if (!value || typeof value !== 'object') return [];
  const rec = value as Record<string, unknown>;
  const own = rec.tag === 'markdown' && typeof rec.content === 'string' ? [rec.content] : [];
  return [...own, ...Object.values(rec).flatMap(markdownContents)];
}
