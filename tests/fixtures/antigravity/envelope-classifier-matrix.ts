export type EnvelopeRetainReason =
  | 'mid-line'
  | 'code-span'
  | 'fence'
  | 'unclosed-no-fingerprint';

export const INCIDENT_A_MESSAGE_ID = 'om_x100b65e6a11b3cb4b10254b74b00974';
export const INCIDENT_A_PROSE = '收到！已经根据你的要求整理完初稿。';
export const INCIDENT_A_ENVELOPE =
  '<SYSTEM_MESSAGE>\n{"type":"task_complete","task_id":"bg-1","cwd":"/tmp/workspace"}\n</SYSTEM_MESSAGE>';
export const PREAMBLE_LINE =
  'The following is a <SYSTEM_MESSAGE> not actually sent by the user.';

export interface EnvelopeMatrixRow {
  id: 'A1' | 'A2' | 'A3' | 'A4' | 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'C1' | 'T1';
  input: string;
  expectedText: string;
  removedCount: number;
  unclosed: boolean;
  preambleRemoved: boolean;
  retainedReasons: EnvelopeRetainReason[];
}

const A1_INPUT = [
  '<SYSTEM_MESSAGE>',
  '[Message] timestamp=2026-09-18T12:26:00+08:00',
  '[Message] content=task_complete',
  '</SYSTEM_MESSAGE>',
  INCIDENT_A_PROSE,
].join('\n');

const A3_INPUT = [
  '<SYSTEM_MESSAGE>',
  '[Message] timestamp=2026-09-18T12:26:00+08:00',
  '[Message] sender=antigravity',
  'truncated envelope body that must not leak',
].join('\n');

const A4_INPUT = [
  PREAMBLE_LINE,
  '<SYSTEM_MESSAGE>',
  '[Message] content=task_complete',
  '</SYSTEM_MESSAGE>',
  INCIDENT_A_PROSE,
].join('\n');

const B1_INPUT = [
  'See also <SYSTEM_MESSAGE> in the docs.',
  '- a list item cites <SYSTEM_MESSAGE> mid-content',
  '> a blockquote cites <SYSTEM_MESSAGE> mid-content',
].join('\n');

const B2_INPUT = 'Use `<SYSTEM_MESSAGE>` when writing the prompt.';

const B3_INPUT = [
  '```',
  '<SYSTEM_MESSAGE>',
  '[Message] timestamp=2026-09-18T00:00:00Z',
  '```',
  'kept after fence',
].join('\n');

const B4_INPUT = [
  'FAIL tests/unit/agent/antigravity-jsonl.test.ts',
  '<SYSTEM_MESSAGE> blocks must not peel the rest of the answer',
  '请看后面的说明。',
].join('\n');

const B5_INPUT = 'oops </SYSTEM_MESSAGE> leftover closer';

const C1_INPUT = '<SYSTEM_MESSAGE>outer<SYSTEM_MESSAGE>inner</SYSTEM_MESSAGE>keep';

const T1_INPUT = [
  '<SYSTEM_MESSAGE>',
  '[Message] content=task_complete',
  '</SYSTEM_MESSAGE>',
  'See <SYSTEM_MESSAGE> cited.',
  INCIDENT_A_PROSE,
].join('\n');

export const ENVELOPE_CLASSIFIER_MATRIX: EnvelopeMatrixRow[] = [
  {
    id: 'A1',
    input: A1_INPUT,
    expectedText: INCIDENT_A_PROSE,
    removedCount: 1,
    unclosed: false,
    preambleRemoved: false,
    retainedReasons: [],
  },
  {
    id: 'A2',
    input: `${INCIDENT_A_ENVELOPE}\n${INCIDENT_A_PROSE}`,
    expectedText: INCIDENT_A_PROSE,
    removedCount: 1,
    unclosed: false,
    preambleRemoved: false,
    retainedReasons: [],
  },
  {
    id: 'A3',
    input: A3_INPUT,
    expectedText: '',
    removedCount: 1,
    unclosed: true,
    preambleRemoved: false,
    retainedReasons: [],
  },
  {
    id: 'A4',
    input: A4_INPUT,
    expectedText: INCIDENT_A_PROSE,
    removedCount: 1,
    unclosed: false,
    preambleRemoved: true,
    retainedReasons: [],
  },
  {
    id: 'B1',
    input: B1_INPUT,
    expectedText: B1_INPUT,
    removedCount: 0,
    unclosed: false,
    preambleRemoved: false,
    retainedReasons: ['mid-line', 'mid-line', 'mid-line'],
  },
  {
    id: 'B2',
    input: B2_INPUT,
    expectedText: B2_INPUT,
    removedCount: 0,
    unclosed: false,
    preambleRemoved: false,
    retainedReasons: ['code-span'],
  },
  {
    id: 'B3',
    input: B3_INPUT,
    expectedText: B3_INPUT,
    removedCount: 0,
    unclosed: false,
    preambleRemoved: false,
    retainedReasons: ['fence'],
  },
  {
    id: 'B4',
    input: B4_INPUT,
    expectedText: B4_INPUT,
    removedCount: 0,
    unclosed: false,
    preambleRemoved: false,
    retainedReasons: ['unclosed-no-fingerprint'],
  },
  {
    id: 'B5',
    input: B5_INPUT,
    expectedText: B5_INPUT,
    removedCount: 0,
    unclosed: false,
    preambleRemoved: false,
    retainedReasons: [],
  },
  {
    id: 'C1',
    input: C1_INPUT,
    expectedText: 'keep',
    removedCount: 1,
    unclosed: false,
    preambleRemoved: false,
    retainedReasons: [],
  },
  {
    id: 'T1',
    input: T1_INPUT,
    expectedText: `See <SYSTEM_MESSAGE> cited.\n${INCIDENT_A_PROSE}`,
    removedCount: 1,
    unclosed: false,
    preambleRemoved: false,
    retainedReasons: ['mid-line'],
  },
];

export function matrixRow(id: EnvelopeMatrixRow['id']): EnvelopeMatrixRow {
  const row = ENVELOPE_CLASSIFIER_MATRIX.find((entry) => entry.id === id);
  if (!row) {
    throw new Error(`missing envelope classifier matrix row ${id}`);
  }
  return row;
}
