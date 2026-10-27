import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import { readdirSync } from 'node:fs';
import { compactRepeats, fixtureText, replay, replayKinds, transcriptCase, type ReplayCase, type ReplayKind } from '../../helpers/transcript-replay';
import { syntheticBoundaries } from '../../fixtures/transcripts/synthetic-boundaries';
import { ENVELOPE_CLASSIFIER_MATRIX, TASK_NOTIFICATION_MATRIX } from '../../fixtures/antigravity/envelope-classifier-matrix';

describe('D03b real capture baseline', () => {
  for (const kind of replayKinds) {
    const scenarios = readdirSync(new URL(`../../fixtures/transcripts/${kind}/`, import.meta.url)).filter(name => name.endsWith('.jsonl')).sort();
    it.each(scenarios)(`${kind}/%s`, filename => {
      expect(replayChecked(transcriptCase(kind, filename.slice(0, -6)))).toMatchSnapshot();
    });
  }
});

describe('D03b existing fixture baseline', () => {
  for (const kind of ['grok', 'antigravity'] as const) {
    const files = readdirSync(new URL(`../../fixtures/${kind}/`, import.meta.url)).filter(name => name.endsWith('.jsonl') || name.endsWith('.err')).sort();
    it.each(files)(`${kind}/%s`, filename => {
      const text = scrubLegacyFixture(fixtureText(`${kind}/${filename}`));
      const steps: ReplayCase['steps'] = filename.endsWith('.err')
        ? [{ method: 'fail', args: [text.trim()] }]
        : text.trim().split('\n').map(line => ({ method: 'translate', args: [JSON.parse(line)] }));
      steps.push({ method: 'finish', args: [] });
      expect(replayChecked({ kind, name: filename, source: `${kind}/${filename}`, steps })).toMatchSnapshot();
    });
  }
  const root = new URL('../../fixtures/goldens/stderr/', import.meta.url);
  for (const folder of readdirSync(root).sort()) {
    // Network samples have no CLI attribution: applying them to each fail()
    // seam is synthetic characterization, not a new protocol observation.
    const kinds: readonly ReplayKind[] = folder === 'network' ? replayKinds : [folder as ReplayKind];
    for (const filename of readdirSync(new URL(`${folder}/`, root)).sort()) {
      it.each(kinds)(`stderr/${folder}/${filename} -> %s fail`, kind => {
        const error = scrubLegacyFixture(fixtureText(`goldens/stderr/${folder}/${filename}`)).trim();
        expect(replayChecked({ kind, name: filename, source: `goldens/stderr/${folder}/${filename}`, steps: [{ method: 'fail', args: [error] }] })).toMatchSnapshot();
      });
    }
  }
  it.each([...ENVELOPE_CLASSIFIER_MATRIX, ...TASK_NOTIFICATION_MATRIX])('existing synthetic envelope matrix $id', row => {
    expect(replayChecked({ kind: 'antigravity', name: row.id, source: 'antigravity/envelope-classifier-matrix.ts (synthetic)', steps: [
      { method: 'translate', args: [{ event: 'result', result: { status: 'SUCCESS', response: scrubLegacyFixture(row.input) } }] },
    ] })).toMatchSnapshot();
  });
});

describe('D03b frozen unit protocol inputs at 222d4c72', () => {
  for (const kind of replayKinds) {
    const entries: ReplayCase[] = JSON.parse(fixtureText(`transcripts/unit-inputs/${kind}.json`));
    for (const entry of entries) {
      it(`${kind} ${entry.source} > ${entry.name}`, () => {
        expect(compactRepeats(replayChecked(entry))).toMatchSnapshot();
      });
    }
  }
});

describe('D03b synthetic boundary baseline (not CLI captures)', () => {
  for (const kind of replayKinds) {
    it.each(syntheticBoundaries(kind))(`${kind} $name`, entry => {
      expect(replayChecked(entry)).toMatchSnapshot();
    });
  }
});

function scrubLegacyFixture(text: string): string {
  const identities = new Map<string, string>();
  return text
    .replace(/(?:\/Users|\/home)\/[^/\s"\\]+/g, '<HOME>')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '<EMAIL>')
    .replace(/\b(?:ou|oc|om|cli)_[A-Za-z0-9]+/g, value => {
      if (!identities.has(value)) identities.set(value, `<IDENTITY_${identities.size + 1}>`);
      return identities.get(value)!;
    })
    .replace(/sk-this-is-not-a-real-secret/g, '<SYNTHETIC_TOKEN>');
}

/** D04 event-contract checks accompany every D03b literal, including frozen unit inputs. */
function replayChecked(entry: ReplayCase): AgentEvent[] {
  const events = replay(entry);
  const open = new Set<string>();
  let terminal = false;
  for (const event of events) {
    if (event.type === 'system') expect(Boolean(event.resumeHandle || event.cwd || event.model)).toBe(true);
    if (entry.kind === 'claude') continue;
    expect(terminal, 'no final-answer events after terminal').toBe(false);
    if (event.type === 'tool_use') {
      expect(open.has(event.id), 'a call opens once').toBe(false);
      open.add(event.id);
    }
    if (event.type === 'tool_result') {
      expect(open.delete(event.id), 'each result follows its use').toBe(true);
    }
    if (event.type === 'done' || event.type === 'error') {
      terminal = true;
      expect([...open], 'terminal fails every unfinished call').toEqual([]);
    }
  }
  return events;
}
