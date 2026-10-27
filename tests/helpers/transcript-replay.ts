import { readFileSync } from 'node:fs';
import { ClaudeStreamTranslator } from '../../src/agent/claude/stream-json';
import { CodexJsonlTranslator } from '../../src/agent/codex/jsonl';
import { KimiJsonlTranslator } from '../../src/agent/kimi/jsonl';
import { GrokJsonlTranslator } from '../../src/agent/grok/jsonl';
import { CursorJsonlTranslator } from '../../src/agent/cursor/jsonl';
import { AntigravityJsonlTranslator } from '../../src/agent/antigravity/jsonl';
import { DevinTranscriptTranslator } from '../../src/agent/devin/transcript';
import type { AgentEvent } from '../../src/agent/types';
import { stripTerminalText } from '../../src/agent/terminal-text';

export const replayKinds = ['claude', 'codex', 'kimi', 'grok', 'cursor', 'antigravity', 'devin'] as const;
export type ReplayKind = typeof replayKinds[number];
export interface ReplayStep {
  method: 'translate' | 'finish' | 'fail';
  args: unknown[];
}
export interface ReplayCase {
  kind: ReplayKind;
  name: string;
  source: string;
  steps: ReplayStep[];
}

const translators = {
  claude: ClaudeStreamTranslator, codex: CodexJsonlTranslator, kimi: KimiJsonlTranslator,
  grok: GrokJsonlTranslator, cursor: CursorJsonlTranslator,
  antigravity: AntigravityJsonlTranslator, devin: DevinTranscriptTranslator,
};

/** A fresh real translator per sequence; no adapter, process, credentials or clock. */
export function replay(entry: ReplayCase): AgentEvent[] {
  const translator = new translators[entry.kind]();
  const events: AgentEvent[] = [];
  for (const step of entry.steps) {
    // Reflect preserves omitted arguments, Devin's replay flag, and each kind's
    // distinct finish reasons without making the production APIs more generic.
    events.push(...Reflect.apply(translator[step.method], translator, step.args.map(expandInput)));
  }
  return events;
}

function expandInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expandInput);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('$error' in record) return new Error(String(record.$error));
    if ('$undefined' in record) return undefined;
    if ('$repeat' in record) {
      const [text, count] = record.$repeat as [string, number];
      return text.repeat(count);
    }
    if ('$runs' in record) return (record.$runs as [string, number][]).map(([text, count]) => text.repeat(count)).join('');
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, expandInput(item)]));
  }
  return value;
}

/** Lossless display of the multi-megabyte line-cap cases, including suffixes. */
export function compactRepeats(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 4096) {
    const runs: [string, number][] = [];
    for (const character of value) {
      const previous = runs[runs.length - 1];
      if (previous?.[0] === character) previous[1]++;
      else runs.push([character, 1]);
    }
    if (runs.some(([, count]) => count >= 256)) return { $runs: runs };
  }
  if (Array.isArray(value)) return value.map(compactRepeats);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactRepeats(item)]));
  return value;
}

interface CaptureRecord {
  kind?: ReplayKind;
  scenario?: string;
  line?: string;
  update?: unknown;
  stderr?: string;
  note?: string;
  exit?: { code: number | null; signal: string | null };
}

export function fixtureText(path: string): string {
  return readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8');
}

export function transcriptCase(kind: ReplayKind, scenario: string): ReplayCase {
  const source = `transcripts/${kind}/${scenario}.jsonl`;
  const records: CaptureRecord[] = fixtureText(source).trim().split('\n').map(line => JSON.parse(line));
  if (records[0]?.kind !== kind || records[0]?.scenario !== scenario) throw new Error(`Bad header: ${source}`);
  const exit = records.find(record => record.exit)?.exit;
  if (!exit) throw new Error(`Missing exit: ${source}`);
  const steps: ReplayStep[] = [];
  for (const record of records) {
    if (kind === 'devin' && record.update !== undefined) {
      steps.push({ method: 'translate', args: [record.update] });
    } else if (typeof record.line === 'string') {
      // Match wrapParsedTranslator's handling of non-JSON stdout.
      try { steps.push({ method: 'translate', args: [JSON.parse(record.line)] }); } catch { /* ignored by runner */ }
    }
  }
  if (kind === 'devin') {
    const note = records.find(record => record.note?.startsWith('terminal event: '))?.note;
    if (!note) throw new Error(`Missing ACP settlement annotation: ${source}`);
    const terminal: AgentEvent = JSON.parse(note.slice('terminal event: '.length));
    if (terminal.type === 'error') steps.push({ method: 'fail', args: [terminal.message] });
    else if (terminal.type === 'done') steps.push({ method: 'finish', args: [terminal.terminationReason === 'interrupted' ? 'cancelled' : 'end_turn'] });
    else throw new Error(`Unexpected ACP settlement: ${source}`);
  } else if (records.some(record => record.note?.includes('SIGTERM sent'))) {
    steps.push({ method: 'finish', args: ['interrupted'] });
  } else if (exit.code !== 0 && exit.code !== null) {
    const name = kind === 'antigravity' ? 'agy' : kind;
    const stderr = stripTerminalText(records.filter(record => record.stderr !== undefined).map(record => record.stderr).join('\n')).trim().slice(0, 500);
    steps.push({ method: 'fail', args: [`${name} exited with code ${exit.code}${stderr ? `: ${stderr}` : ''}`] });
  } else {
    steps.push({ method: 'finish', args: kind === 'kimi' ? ['normal'] : [] });
  }
  return { kind, name: `${kind}/${scenario}`, source, steps };
}
