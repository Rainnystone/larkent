import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState, reduce, type RunState } from '../../../src/card/run-state';
import { toolBodyMd, toolHeaderText } from '../../../src/card/tool-render';

/** Worked example from P09d: POSIX heredoc wrapping the shared client. */
const CLIENT_PATH = '/opt/larkent/bin/lark-channel-bridge.mjs';
const LIST_REQUEST =
  '{"version":1,"operation":"automation.list","params":{},"operationId":"op1.scope.1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}';
const CREATE_REQUEST =
  '{"version":1,"operation":"automation.create","params":{"taskType":"reminder","name":"ping","taskText":"hi"},"operationId":"op1.scope.1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}';
const INSPECT_REQUEST = '{"version":1,"operation":"plugins.inspect","params":{"plugin":"automation"}}';
const LIST_STDOUT =
  '{"version":1,"category":"ok","code":"tasks","data":{"operationId":"op1.scope.1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}';

const POSIX_LIST_COMMAND = `node "$LARK_BRIDGE_TOOL_CLIENT" tool <<'EOF'\n${LIST_REQUEST}\nEOF`;
const POSIX_CREATE_COMMAND = `node "$LARK_BRIDGE_TOOL_CLIENT" tool <<'EOF'\n${CREATE_REQUEST}\nEOF`;
const POWERSHELL_LIST_COMMAND = 'node "$env:LARK_BRIDGE_TOOL_CLIENT" tool';
const EXPANDED_LIST_COMMAND = `node "${CLIENT_PATH}" tool <<'EOF'\n${LIST_REQUEST}\nEOF`;

describe('bridge tool progress-card labels', () => {
  it('folds a successful bridge call fed by literal piped stdin', () => {
    const command = `printf '%s\\n' '${LIST_REQUEST}' | node "$LARK_BRIDGE_TOOL_CLIENT" tool`;
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command } },
      { type: 'tool_result', id: 'tool-1', output: LIST_STDOUT, isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const card = JSON.stringify(renderCard(state));

    expect(card).toContain('✅ **自动化：list**');
    expectCardHidesInternals(card);
  });

  it('folds a bridge call fed by a quoted heredoc through cat', () => {
    const command = `cat <<'EOF' | node "$LARK_BRIDGE_TOOL_CLIENT" tool\n${LIST_REQUEST}\nEOF`;
    const card = JSON.stringify(renderCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command } },
      { type: 'tool_result', id: 'tool-1', output: LIST_STDOUT, isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])));

    expect(card).toContain('✅ **自动化：list**');
    expectCardHidesInternals(card);
  });

  it('keeps a chained shell failure and its command visible', () => {
    const command = `node "$LARK_BRIDGE_TOOL_CLIENT" tool ; ls /nonexistent-synthetic-card-path`;
    const output = `${LIST_STDOUT}\nls: cannot access '/nonexistent-synthetic-card-path': No such file or directory`;
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command, stdin: LIST_REQUEST } },
      { type: 'tool_result', id: 'tool-1', output, isError: true },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const card = JSON.stringify(renderCard(state));

    expect(card).toContain(JSON.stringify(command).slice(1, -1));
    expect(card).toContain("ls: cannot access '/nonexistent-synthetic-card-path'");
    expect(card).toContain('❌');
    expect(card).toContain('"color":"red"');
    expect(card).not.toContain('✅');
  });

  it.each([
    'node "$LARK_BRIDGE_TOOL_CLIENT" tool; ls /missing',
    'node "$LARK_BRIDGE_TOOL_CLIENT" tool && ls /missing',
    'node "$LARK_BRIDGE_TOOL_CLIENT" tool || echo recovered',
    'false | node "$LARK_BRIDGE_TOOL_CLIENT" tool',
    'node "$LARK_BRIDGE_TOOL_CLIENT" tool | cat',
    'node "$LARK_BRIDGE_TOOL_CLIENT" tool\nls /missing',
    `${POSIX_LIST_COMMAND}\nls /missing`,
    `node "$LARK_BRIDGE_TOOL_CLIENT" tool <<'EOF' ; ls /missing\n${LIST_REQUEST}\nEOF`,
    `printf '%s' "$(ls /missing)" | node "$LARK_BRIDGE_TOOL_CLIENT" tool`,
    `printf '%s' '\`ls /missing\`' | node "$LARK_BRIDGE_TOOL_CLIENT" tool && echo done`,
    'echo "$LARK_BRIDGE_TOOL_CLIENT" tool',
    'node "$LARK_BRIDGE_TOOL_CLIENT" tool > /tmp/synthetic-output',
    'node "$LARK_BRIDGE_TOOL_CLIENT" tool &',
    `node "$LARK_BRIDGE_TOOL_CLIENT" tool <<EOF\n$(ls /missing)\nEOF`,
  ])('retains raw command and output for compound or uncertain shell input: %s', (command) => {
    const card = JSON.stringify(renderCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command } },
      { type: 'tool_result', id: 'tool-1', output: 'synthetic shell diagnostic', isError: true },
      { type: 'done', terminationReason: 'normal' },
    ])));

    expect(card).toContain(JSON.stringify(command).slice(1, -1));
    expect(card).toContain('synthetic shell diagnostic');
    expect(card).toContain('❌');
    expect(card).not.toContain('✅');
  });

  it.each([
    `echo '${LIST_REQUEST}' | node "$LARK_BRIDGE_TOOL_CLIENT" tool`,
    `printf '%s' '{"operation":"automation.list","params":{"text":"literal ; && || | $(data) ` + '`data`' + `"}}' | node "$LARK_BRIDGE_TOOL_CLIENT" tool`,
    `node "${CLIENT_PATH}" tool <<'EOF'\n{"operation":"automation.list","text":"; && || | $(data)"}\nEOF`,
    `node "${CLIENT_PATH}" tool <<EOF\n${LIST_REQUEST}\nEOF`,
  ])('folds literal stdin without interpreting quoted payload as shell code: %s', (command) => {
    const card = JSON.stringify(renderCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command } },
      { type: 'tool_result', id: 'tool-1', output: LIST_STDOUT, isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])));

    expect(card).toContain('✅ **自动化：list**');
    expectCardHidesInternals(card);
  });

  it.each([
    ['Shell', { cmd: 'node "$LARK_BRIDGE_TOOL_CLIENT" tool ; ls /missing' }],
    ['command_execution', { command: ['bash', '-lc', 'node "$LARK_BRIDGE_TOOL_CLIENT" tool ; ls /missing'] }],
    ['Shell', { rawInput: { command: 'node "$LARK_BRIDGE_TOOL_CLIENT" tool ; ls /missing' } }],
    ['Bash', 'node "$LARK_BRIDGE_TOOL_CLIENT" tool ; ls /missing'],
  ])('keeps compound command details from %s input', (name, input) => {
    const card = JSON.stringify(renderCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name, input },
      { type: 'tool_result', id: 'tool-1', output: 'synthetic shell diagnostic', isError: true },
      { type: 'done', terminationReason: 'normal' },
    ])));

    expect(card).toContain('tool ; ls /missing');
    expect(card).toContain('synthetic shell diagnostic');
    expect(card).toContain('❌');
  });

  it.each([
    'node "$LARK_BRIDGE_TOOL_CLIENT" tool ; ls /missing',
    String.raw`node /synthetic/lark-channel-\bridge.mjs tool ; ls /missing`,
    "node /synthetic/lark-'channel'-bridge.mjs tool ; ls /missing",
  ])('retains compound details when other tool calls are summarized: %s', (command) => {
    const events: AgentEvent[] = [];
    for (const id of ['one', 'two', 'three']) {
      events.push(
        { type: 'tool_use', id, name: 'Bash', input: { command: 'pwd' } },
        { type: 'tool_result', id, output: '/synthetic', isError: false },
      );
    }
    events.push(
      { type: 'tool_use', id: 'failure', name: 'Bash', input: { command } },
      { type: 'tool_result', id: 'failure', output: 'ls: synthetic missing path', isError: true },
      { type: 'done', terminationReason: 'normal' },
    );
    const card = JSON.stringify(renderCard(stateFrom(events)));

    expect(card).toContain('3 个工具调用');
    expect(card).toContain('tool ; ls /missing');
    expect(card).toContain('ls: synthetic missing path');
    expect(card).toContain('❌');
  });

  it.each([
    ['Bash', POSIX_LIST_COMMAND],
    ['Shell', POSIX_LIST_COMMAND],
    ['command_execution', POSIX_LIST_COMMAND],
  ] as const)('renders %s automation.list as 自动化：list without leaking the client', (name, command) => {
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name, input: { command } },
      { type: 'tool_result', id: 'tool-1', output: LIST_STDOUT, isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const tool = toolOf(state);
    const card = JSON.stringify(renderCard(state));

    expect(toolHeaderText(tool)).toBe('✅ **自动化：list**');
    expect(toolBodyMd(tool)).toBe('');
    expect(card).toContain('自动化：list');
    expectCardHidesInternals(card);
  });

  it('renders PowerShell stdin wrapping as 自动化：create', () => {
    const state = stateFrom([
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Shell',
        input: { command: 'node "$env:LARK_BRIDGE_TOOL_CLIENT" tool', stdin: CREATE_REQUEST },
      },
      { type: 'tool_result', id: 'tool-1', output: LIST_STDOUT, isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const card = JSON.stringify(renderCard(state));

    expect(toolHeaderText(toolOf(state))).toBe('✅ **自动化：create**');
    expect(card).toContain('自动化：create');
    expectCardHidesInternals(card);
  });

  it('renders plugins.inspect as 插件：inspect', () => {
    const state = stateFrom([
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: `node "$LARK_BRIDGE_TOOL_CLIENT" tool <<'EOF'\n${INSPECT_REQUEST}\nEOF` },
      },
      { type: 'tool_result', id: 'tool-1', output: '{"version":1,"category":"ok","code":"plugin"}', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const card = JSON.stringify(renderCard(state));

    expect(toolHeaderText(toolOf(state))).toBe('✅ **插件：inspect**');
    expect(card).toContain('插件：inspect');
    expectCardHidesInternals(card);
  });

  it('falls back to bridge 工具 when the operation cannot be parsed', () => {
    const state = stateFrom([
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'node "$LARK_BRIDGE_TOOL_CLIENT" tool --schema' },
      },
      { type: 'tool_result', id: 'tool-1', output: '{"type":"object"}', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const card = JSON.stringify(renderCard(state));

    expect(toolHeaderText(toolOf(state))).toBe('✅ **bridge 工具**');
    expect(card).toContain('bridge 工具');
    expectCardHidesInternals(card);
  });

  it('still renders an ordinary shell command as-is', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const tool = toolOf(state);

    expect(toolHeaderText(tool)).toBe('✅ **Bash** — pwd');
    expect(toolBodyMd(tool)).toContain('pwd');
    expect(toolBodyMd(tool)).toContain('/repo');
    expect(JSON.stringify(renderCard(state))).toContain('pwd');
  });

  it('does not fold a shell command that only mentions the client env var', () => {
    const command = 'echo "$LARK_BRIDGE_TOOL_CLIENT"';
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command } },
      { type: 'tool_result', id: 'tool-1', output: CLIENT_PATH, isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const tool = toolOf(state);

    expect(toolHeaderText(tool)).toBe(`✅ **Bash** — ${command}`);
    expect(toolBodyMd(tool)).toContain(command);
  });

  it('uses friendly labels in the collapsed tool-call summary', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: POSIX_LIST_COMMAND } },
      { type: 'tool_result', id: 'tool-1', output: LIST_STDOUT, isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Shell', input: { command: POSIX_CREATE_COMMAND } },
      { type: 'tool_result', id: 'tool-2', output: LIST_STDOUT, isError: false },
      {
        type: 'tool_use',
        id: 'tool-3',
        name: 'Bash',
        input: { command: `node "$LARK_BRIDGE_TOOL_CLIENT" tool <<'EOF'\n${INSPECT_REQUEST}\nEOF` },
      },
      { type: 'tool_result', id: 'tool-3', output: '{"version":1,"category":"ok","code":"plugin"}', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const card = JSON.stringify(renderCard(state));

    expect(card).toContain('3 个工具调用');
    expect(card).toContain('自动化：list');
    expect(card).toContain('自动化：create');
    expect(card).toContain('插件：inspect');
    expectCardHidesInternals(card);
  });

  it('shows an error-state label with a red border and no protocol body', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: POSIX_LIST_COMMAND } },
      { type: 'tool_result', id: 'tool-1', output: LIST_STDOUT, isError: true },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const card = JSON.stringify(renderCard(state));
    const tool = toolOf(state);

    expect(toolHeaderText(tool)).toBe('❌ **自动化：list**');
    expect(toolBodyMd(tool)).toBe('');
    expect(card).toContain('"color":"red"');
    expect(card).not.toContain('**Error**');
    expectCardHidesInternals(card);
  });

  it('labels an expanded-path client invocation so the path does not leak', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: EXPANDED_LIST_COMMAND } },
      { type: 'tool_result', id: 'tool-1', output: LIST_STDOUT, isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const card = JSON.stringify(renderCard(state));

    expect(toolHeaderText(toolOf(state))).toBe('✅ **自动化：list**');
    expect(card).not.toContain(CLIENT_PATH);
    expectCardHidesInternals(card);
  });
});

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

function toolOf(state: RunState) {
  const block = state.blocks.find((entry) => entry.kind === 'tool');
  expect(block?.kind).toBe('tool');
  if (block?.kind !== 'tool') throw new Error('expected tool block');
  return block.tool;
}

function expectCardHidesInternals(card: string): void {
  expect(card).not.toContain('LARK_BRIDGE_TOOL_CLIENT');
  expect(card).not.toContain(CLIENT_PATH);
  expect(card).not.toContain('"operation"');
  expect(card).not.toContain('operationId');
  expect(card).not.toContain(POWERSHELL_LIST_COMMAND);
  expect(card).not.toContain('_无输出_');
}
