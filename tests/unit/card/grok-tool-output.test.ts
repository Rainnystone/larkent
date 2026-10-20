import { spawnSync } from 'node:child_process';
import { mergeProcessEnv } from '../../../src/platform/spawn';
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
  it('cleans structured tool output before JSON serialization while preserving diagnostic text', () => {
    const text = grokCard('read_file', 'read', { path: '\u001b[33mnotes.txt\u001b[39m' }, { type: 'ReadFile', content: '\u001b[31mread failed: missing file\u001b[39m' });
    expect(text).toContain('notes.txt');
    expect(text).toContain('read failed: missing file');
    expect(text).not.toMatch(/[\u001b\u009b]|\\u001b/);
  });

  it.each([0, 2])('renders actual colored Node subprocess output as plain text, retaining exit %s and diagnostics', exitCode => {
    const child = spawnSync(process.execPath, ['-e', `console.log(42); console.error("\\u001b[31mreal diagnostic\\u001b[39m"); process.exitCode = ${exitCode}`], {
      env: mergeProcessEnv(process.env, { FORCE_COLOR: '1', NO_COLOR: undefined }), encoding: 'utf8',
    });
    expect(child.status).toBe(exitCode);
    const output = child.stdout + child.stderr;
    expect(output).toContain('\u001b[');
    const command = 'node -e "console.log(42)"';
    const text = grokCard('run_terminal_command', 'execute', { command }, { type: 'Bash', exit_code: child.status, output: [...Buffer.from(output)] });
    expect(text).toContain(exitCode ? '❌' : '✅');
    expect(text).toContain(command);
    expect(text).toContain('42');
    expect(text).toContain('real diagnostic');
    expect(text).not.toMatch(/[\u001b\u009b]/);
  });

  // Replay of the event fields reported by the independent Grok Build 1.0.41
  // live acceptance owner. Commands/output are synthetic; no local Grok login.
  it('renders a completed run_terminal_command exit 2 as failure with command and output', () => {
    const command = `node "$LARK_BRIDGE_TOOL_CLIENT" tool <<'JSON' && ls /nonexistent-synthetic-card-path
{"version":1,"operation":"automation.list"}
JSON`;
    const output = "ls: cannot access '/nonexistent-synthetic-card-path': No such file or directory";
    const text = grokCard('run_terminal_command', 'execute', { command }, { type: 'Bash', exit_code: 2, output: [...Buffer.from(output)] });
    expect(text).toContain('❌');
    expect(text).not.toContain('✅');
    expect(text).toContain(command);
    expect(text).toContain(output);
  });

  it.each([
    `printf '%s' '{"version":1,"operation":"automation.list"}' | node "$LARK_BRIDGE_TOOL_CLIENT" tool`,
    `node "$LARK_BRIDGE_TOOL_CLIENT" tool <<'JSON'
{"version":1,"operation":"automation.list"}
JSON`,
  ])('keeps a successful native shell bridge call folded: %s', command => {
    const text = grokCard('run_terminal_command', 'execute', { command }, { type: 'Bash', exit_code: 0, output: [...Buffer.from('synthetic protocol payload')] });
    expect(text).toContain('✅ **自动化：list**');
    expect(text).not.toContain('❌');
    expect(text).not.toContain(command);
    expect(text).not.toContain('synthetic protocol payload');
  });

  it('keeps successful native shell command and JSON output visible', () => {
    const text = grokCard('run_terminal_command', 'execute', { command: 'node -e "console.log(42)"' }, { type: 'Bash', exit_code: 0, output: [...Buffer.from('{"exitCode":2}')] });
    expect(text).toContain('✅');
    expect(text).not.toContain('❌');
    expect(text).toContain('console.log(42)');
    expect(text).toContain('{"exitCode":2}');
  });

  it('keeps read_file exit-code domain data successful', () => {
    const text = grokCard('read_file', 'read', { path: 'synthetic.json' }, { type: 'ReadFile', exit_code: 2, content: '{"exitCode":2}' });
    expect(text).toContain('✅');
    expect(text).not.toContain('❌');
    expect(text).toContain('exitCode');
  });

  it.each(['exitCode', 'exit_code'])('keeps a completed plugin card successful with %s domain data', (field) => {
    const translator = new GrokJsonlTranslator();
    const events = [
      ...translator.translate({
        type: 'tool_call', toolCallId: 'plugin', toolName: 'mcp_process_report', status: 'in_progress',
        rawInput: {},
      }),
      ...translator.translate({
        type: 'tool_call_update', toolCallId: 'plugin', status: 'completed', rawOutput: { [field]: 2 },
      }),
    ];
    const card = renderCard(events.reduce((state, event) => reduce(state, event), initialState));
    const text = markdownContents(card).join('\n');

    expect(text).toContain('✅');
    expect(text).not.toContain('❌');
    expect(text).toContain(`{"${field}":2}`);
  });

  it.each(['exitCode', 'exit_code'])('does not mistake successful JSON stdout for %s metadata', (field) => {
    const translator = new GrokJsonlTranslator();
    const output = JSON.stringify({ [field]: 2 });
    const events = [
      ...translator.translate({
        type: 'tool_call', toolCallId: 'json_stdout', toolName: 'Bash', status: 'in_progress',
        rawInput: { command: `printf '%s' '${output}'` },
      }),
      ...translator.translate({
        type: 'tool_call_update', toolCallId: 'json_stdout', status: 'completed',
        rawOutput: { type: 'Bash', output: [...Buffer.from(output)], exitCode: 0 },
      }),
    ];
    const card = renderCard(events.reduce((state, event) => reduce(state, event), initialState));
    const text = markdownContents(card).join('\n');

    expect(text).toContain('✅');
    expect(text).not.toContain('❌');
    expect(text).toContain(output);
  });

  it.each([
    'node "$LARK_BRIDGE_TOOL_CLIENT" tool ; ls /nonexistent-synthetic-card-path',
    'node "$LARK_BRIDGE_TOOL_CLIENT" tool',
  ])('shows a nonzero shell exit as failure even when the tool completed: %s', (command) => {
    const translator = new GrokJsonlTranslator();
    const output = "ls: cannot access '/nonexistent-synthetic-card-path': No such file or directory";
    const events = [
      ...translator.translate({
        type: 'tool_call', toolCallId: 'call_failure', toolName: 'Bash', status: 'in_progress',
        rawInput: { command, stdin: '{"operation":"automation.list"}' },
      }),
      ...translator.translate({
        type: 'tool_call_update', toolCallId: 'call_failure', status: 'completed',
        rawOutput: { type: 'Bash', output: [...Buffer.from(output)], exitCode: 2 },
      }),
    ];
    const state = events.reduce((next, event) => reduce(next, event), initialState);
    const card = renderCard(state);
    const text = markdownContents(card).join('\n');

    expect(text).toContain('❌');
    expect(text).not.toContain('✅');
    expect(JSON.stringify(card)).toContain('"color":"red"');
    if (command.includes(';')) {
      expect(text).toContain(command);
      expect(text).toContain(output);
    }
  });

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

function grokCard(title: string, kind: string, rawInput: object, rawOutput: object): string {
  const translator = new GrokJsonlTranslator();
  const events = [
    ...translator.translate({ type: 'tool_call', toolCallId: 'native', title, kind, status: 'in_progress', rawInput }),
    ...translator.translate({ type: 'tool_call_update', toolCallId: 'native', status: 'completed', rawOutput }),
  ];
  return markdownContents(renderCard(events.reduce((state, event) => reduce(state, event), initialState))).join('\n');
}
