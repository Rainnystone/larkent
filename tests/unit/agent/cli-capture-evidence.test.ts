import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { replay, replayKinds, transcriptCase, type ReplayKind } from '../../helpers/transcript-replay';

const CAPTURED_AT = '2026-10-27';

interface CaptureRecord {
  transcript?: number;
  kind?: string;
  cliVersion?: string;
  capturedAt?: string;
  scenario?: string;
  t?: number;
  line?: string;
  update?: Record<string, unknown>;
  stderr?: string;
}

function captureDir(kind: ReplayKind): URL {
  return new URL(`../../fixtures/transcripts/${kind}/`, import.meta.url);
}

function loadRecords(kind: ReplayKind, scenario: string): CaptureRecord[] {
  const text = readFileSync(new URL(`../../fixtures/transcripts/${kind}/${scenario}.jsonl`, import.meta.url), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line) as CaptureRecord);
}

function scenarioNames(kind: ReplayKind): string[] {
  return readdirSync(captureDir(kind)).filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -6));
}

function parsedLines(kind: ReplayKind): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const scenario of scenarioNames(kind)) {
    for (const record of loadRecords(kind, scenario)) {
      if (typeof record.line !== 'string') continue;
      try {
        parsed.push(JSON.parse(record.line) as Record<string, unknown>);
      } catch {
        /* runner ignores non-JSON stdout */
      }
    }
  }
  return parsed;
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([name, item]) => name === key || containsKey(item, key),
    );
  }
  return false;
}

describe('D03a capture inventory (no 1.5.3 recapture on this PATH)', () => {
  it.each(replayKinds)('%s long-tool header records version and 2026-10-27 provenance', (kind) => {
    const header = loadRecords(kind, 'long-tool')[0];
    expect(header?.transcript).toBe(1);
    expect(header?.kind).toBe(kind);
    expect(header?.scenario).toBe('long-tool');
    expect(header?.capturedAt).toBe(CAPTURED_AT);
    expect(header?.cliVersion?.trim().length).toBeGreaterThan(0);
  });

  it('agy long-tool is 1.4.8, not 1.5.3', () => {
    const header = loadRecords('antigravity', 'long-tool')[0];
    expect(header?.cliVersion).toBe('1.4.8');
  });

  it('agy D03a transcripts never include subagent_info', () => {
    for (const scenario of scenarioNames('antigravity')) {
      const text = readFileSync(
        new URL(`../../fixtures/transcripts/${'antigravity'}/${scenario}.jsonl`, import.meta.url),
        'utf8',
      );
      expect(text.includes('"subagent_info"'), scenario).toBe(false);
      for (const record of loadRecords('antigravity', scenario)) {
        let payload: unknown = record;
        if (typeof record.line === 'string') {
          try {
            payload = JSON.parse(record.line);
          } catch {
            payload = record.line;
          }
        }
        expect(containsKey(payload, 'subagent_info'), `${scenario} t=${record.t}`).toBe(false);
      }
    }
  });

  it('agy 1.4.8 tool ACTIVE records carry tool_info.parameters.CommandLine', () => {
    const commands: string[] = [];
    for (const record of loadRecords('antigravity', 'long-tool')) {
      if (typeof record.line !== 'string') continue;
      const raw = JSON.parse(record.line) as {
        event?: string;
        step_update?: {
          state?: string;
          step_type?: string;
          tool_info?: { parameters?: { CommandLine?: string } };
        };
      };
      if (
        raw.event === 'step_update'
        && raw.step_update?.step_type === 'tool'
        && raw.step_update.state === 'ACTIVE'
      ) {
        const command = raw.step_update.tool_info?.parameters?.CommandLine;
        expect(command, `t=${record.t}`).toEqual(expect.any(String));
        if (typeof command === 'string') commands.push(command);
      }
    }
    expect(commands).toEqual(['sleep 45 && echo done']);
  });

  it('agy 1.4.8 two-tools never has two tool ACTIVE overlapping', () => {
    let open = 0;
    let maxOpen = 0;
    for (const record of loadRecords('antigravity', 'two-tools')) {
      if (typeof record.line !== 'string') continue;
      const raw = JSON.parse(record.line) as {
        event?: string;
        step_update?: { state?: string; step_type?: string };
      };
      if (raw.event !== 'step_update' || raw.step_update?.step_type !== 'tool') continue;
      if (raw.step_update.state === 'ACTIVE') open += 1;
      if (raw.step_update.state === 'DONE') open -= 1;
      maxOpen = Math.max(maxOpen, open);
    }
    expect(maxOpen).toBe(1);
  });

  it('codex D03a item types are command_execution, agent_message, and error', () => {
    const itemTypes = new Set<string>();
    for (const raw of parsedLines('codex')) {
      const item = raw.item;
      if (item && typeof item === 'object' && 'type' in item && typeof item.type === 'string') {
        itemTypes.add(item.type);
      }
    }
    expect([...itemTypes].sort()).toEqual(['agent_message', 'command_execution', 'error']);
  });

  it('devin D03a first tool_call per id includes rawInput', () => {
    const first = new Map<string, Record<string, unknown>>();
    for (const scenario of scenarioNames('devin')) {
      for (const record of loadRecords('devin', scenario)) {
        const update = record.update;
        if (!update || update.sessionUpdate !== 'tool_call') continue;
        const id = update.toolCallId;
        if (typeof id !== 'string' || first.has(id)) continue;
        first.set(id, update);
      }
    }
    expect(first.size).toBeGreaterThan(0);
    for (const [id, update] of first) {
      expect(update.rawInput, id).not.toBeUndefined();
      expect(update.rawInput, id).not.toBeNull();
    }
  });

  it.each(replayKinds)('%s long-tool still emits a pairable tool_use and tool_result', (kind) => {
    const events = replay(transcriptCase(kind, 'long-tool'));
    const started = events.find((event) => event.type === 'tool_use');
    expect(started?.type).toBe('tool_use');
    if (started?.type !== 'tool_use') throw new Error('expected tool_use');
    expect(events.some((event) => event.type === 'tool_result' && event.id === started.id)).toBe(true);
  });
});
