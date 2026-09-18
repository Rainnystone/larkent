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
  id: 'A1' | 'A2' | 'A3' | 'A4' | 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'C1' | 'C2' | 'T1';
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

const C1_INPUT =
  '<SYSTEM_MESSAGE>outer<SYSTEM_MESSAGE>inner</SYSTEM_MESSAGE>keep</SYSTEM_MESSAGE>after';
const C2_INPUT = INCIDENT_A_ENVELOPE;

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
    expectedText: 'keep</SYSTEM_MESSAGE>after',
    removedCount: 1,
    unclosed: false,
    preambleRemoved: false,
    retainedReasons: [],
  },
  {
    id: 'C2',
    input: C2_INPUT,
    expectedText: '',
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

export type TaskNotificationMatrixId = 'TN1' | 'TN2' | 'TN3' | 'TN4' | 'TN5' | 'TN6';

export interface TaskNotificationMatrixRow {
  id: TaskNotificationMatrixId;
  input: string;
  expectedText: string;
  removedCount: number;
  unclosed: boolean;
  preambleRemoved: boolean;
  retainedReasons: EnvelopeRetainReason[];
  taskNotificationRetainedReasons: EnvelopeRetainReason[];
}

export const TASK_NOTIFICATION_CHINESE_ANSWER = '这是给用户看的中文答复。';
export const TASK_NOTIFICATION_PROSE = '干净的答复。';
export const TASK_NOTIFICATION_ENVELOPE =
  '<task_notification>\n{"type":"task_update","task_id":"tn-1"}\n</task_notification>';
export const VITEST_TITLE_WITH_SYSTEM_MESSAGE =
  'FAIL tests/unit/agent/antigravity-jsonl.test.ts > scrubs multi-line and nested <SYSTEM_MESSAGE> blocks';

const TN1_INPUT = [
  TASK_NOTIFICATION_ENVELOPE,
  VITEST_TITLE_WITH_SYSTEM_MESSAGE,
  TASK_NOTIFICATION_CHINESE_ANSWER,
].join('\n');
const TN1_EXPECTED = [VITEST_TITLE_WITH_SYSTEM_MESSAGE, TASK_NOTIFICATION_CHINESE_ANSWER].join('\n');

const TN2_INPUT = `${TASK_NOTIFICATION_ENVELOPE}\n${TASK_NOTIFICATION_PROSE}`;
const TN3_INPUT = 'See also <task_notification> in the docs.';
const TN4_INPUT = 'Use `<task_notification>` when writing the prompt.';
const TN5_INPUT = ['```', '<task_notification>', '{"type":"task_update"}', '```', 'kept after fence'].join(
  '\n',
);
const TN6_INPUT = ['<task_notification>', '{"type":"task_update","task_id":"tn-open"}', TASK_NOTIFICATION_CHINESE_ANSWER].join(
  '\n',
);

export const TASK_NOTIFICATION_MATRIX: TaskNotificationMatrixRow[] = [
  {
    id: 'TN1',
    input: TN1_INPUT,
    expectedText: TN1_EXPECTED,
    removedCount: 1,
    unclosed: false,
    preambleRemoved: false,
    retainedReasons: ['mid-line'],
    taskNotificationRetainedReasons: [],
  },
  {
    id: 'TN2',
    input: TN2_INPUT,
    expectedText: TASK_NOTIFICATION_PROSE,
    removedCount: 1,
    unclosed: false,
    preambleRemoved: false,
    retainedReasons: [],
    taskNotificationRetainedReasons: [],
  },
  {
    id: 'TN3',
    input: TN3_INPUT,
    expectedText: TN3_INPUT,
    removedCount: 0,
    unclosed: false,
    preambleRemoved: false,
    retainedReasons: [],
    taskNotificationRetainedReasons: ['mid-line'],
  },
  {
    id: 'TN4',
    input: TN4_INPUT,
    expectedText: TN4_INPUT,
    removedCount: 0,
    unclosed: false,
    preambleRemoved: false,
    retainedReasons: [],
    taskNotificationRetainedReasons: ['code-span'],
  },
  {
    id: 'TN5',
    input: TN5_INPUT,
    expectedText: TN5_INPUT,
    removedCount: 0,
    unclosed: false,
    preambleRemoved: false,
    retainedReasons: [],
    taskNotificationRetainedReasons: ['fence'],
  },
  {
    id: 'TN6',
    input: TN6_INPUT,
    expectedText: TN6_INPUT,
    removedCount: 0,
    unclosed: false,
    preambleRemoved: false,
    retainedReasons: [],
    taskNotificationRetainedReasons: ['unclosed-no-fingerprint'],
  },
];

export function taskNotificationRow(id: TaskNotificationMatrixId): TaskNotificationMatrixRow {
  const row = TASK_NOTIFICATION_MATRIX.find((entry) => entry.id === id);
  if (!row) {
    throw new Error(`missing task_notification matrix row ${id}`);
  }
  return row;
}
