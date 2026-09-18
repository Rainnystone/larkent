export const SYSTEM_MESSAGE_OPEN = '<SYSTEM_MESSAGE>';
export const SYSTEM_MESSAGE_CLOSE = '</SYSTEM_MESSAGE>';
export const TASK_NOTIFICATION_OPEN = '<task_notification>';
export const TASK_NOTIFICATION_CLOSE = '</task_notification>';

export type EnvelopeFamilyId = 'system_message' | 'task_notification';

export type SystemMessageRetainReason =
  | 'mid-line'
  | 'code-span'
  | 'fence'
  | 'unclosed-no-fingerprint';

type EnvelopeTagContext = Exclude<SystemMessageRetainReason, 'unclosed-no-fingerprint'> | 'candidate';

export interface SystemMessageEnvelopeShape {
  readonly id: string;
  readonly afterOpen?: RegExp;
  readonly windowChars?: number;
  readonly precedingLinePrefix?: string;
}

export const SYSTEM_MESSAGE_ENVELOPE_SHAPES: readonly SystemMessageEnvelopeShape[] = [
  {
    id: 'message-header',
    afterOpen: /^\s*\[Message\]\s+(timestamp|sender|priority|content)=/,
    windowChars: 64,
  },
  {
    id: 'injected-preamble',
    precedingLinePrefix: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user',
  },
];

export const TASK_NOTIFICATION_ENVELOPE_SHAPES: readonly SystemMessageEnvelopeShape[] = [];

export interface SystemMessageScrubResult {
  text: string;
  beforeLength: number;
  afterLength: number;
  removedCount: number;
  unclosed: boolean;
  preambleRemoved: boolean;
  retainedReasons: SystemMessageRetainReason[];
  taskNotificationRetainedReasons: SystemMessageRetainReason[];
  removedByFamily: Record<EnvelopeFamilyId, number>;
}

interface StripRange {
  start: number;
  end: number;
  unclosed: boolean;
  preambleRemoved: boolean;
}

interface EnvelopeFamily {
  readonly id: EnvelopeFamilyId;
  readonly open: string;
  readonly close: string;
  readonly shapes: readonly SystemMessageEnvelopeShape[];
}

interface FamilyScrubPass {
  text: string;
  removedCount: number;
  unclosed: boolean;
  preambleRemoved: boolean;
  retainedReasons: SystemMessageRetainReason[];
}

const ENVELOPE_FAMILIES: readonly EnvelopeFamily[] = [
  {
    id: 'system_message',
    open: SYSTEM_MESSAGE_OPEN,
    close: SYSTEM_MESSAGE_CLOSE,
    shapes: SYSTEM_MESSAGE_ENVELOPE_SHAPES,
  },
  {
    id: 'task_notification',
    open: TASK_NOTIFICATION_OPEN,
    close: TASK_NOTIFICATION_CLOSE,
    shapes: TASK_NOTIFICATION_ENVELOPE_SHAPES,
  },
];

export function scrubSystemMessageEnvelopes(input: string): SystemMessageScrubResult {
  let text = input;
  let removedCount = 0;
  let unclosed = false;
  let preambleRemoved = false;
  let retainedReasons: SystemMessageRetainReason[] = [];
  let taskNotificationRetainedReasons: SystemMessageRetainReason[] = [];
  const removedByFamily: Record<EnvelopeFamilyId, number> = {
    system_message: 0,
    task_notification: 0,
  };

  let progress = true;
  while (progress) {
    progress = false;
    for (const family of ENVELOPE_FAMILIES) {
      const pass = scrubFamily(text, family);
      switch (family.id) {
        case 'system_message':
          retainedReasons = pass.retainedReasons;
          break;
        case 'task_notification':
          taskNotificationRetainedReasons = pass.retainedReasons;
          break;
        default: {
          const _exhaustive: never = family.id;
          throw new Error(`unhandled envelope family ${_exhaustive}`);
        }
      }
      if (pass.removedCount === 0) continue;
      text = pass.text;
      removedCount += pass.removedCount;
      unclosed ||= pass.unclosed;
      preambleRemoved ||= pass.preambleRemoved;
      removedByFamily[family.id] += pass.removedCount;
      progress = true;
    }
  }

  return {
    text,
    beforeLength: input.length,
    afterLength: text.length,
    removedCount,
    unclosed,
    preambleRemoved,
    retainedReasons,
    taskNotificationRetainedReasons,
    removedByFamily,
  };
}

function scrubFamily(input: string, family: EnvelopeFamily): FamilyScrubPass {
  const ranges = findStripRanges(input, family);
  const retainedReasons = collectRetainReasons(input, ranges, family);
  if (ranges.length === 0) {
    return {
      text: input,
      removedCount: 0,
      unclosed: false,
      preambleRemoved: false,
      retainedReasons,
    };
  }

  let output = '';
  let cursor = 0;
  let unclosed = false;
  let preambleRemoved = false;
  for (const range of ranges) {
    const expanded = expandStripRange(input, range);
    output += input.slice(cursor, expanded.start);
    cursor = expanded.end;
    if (range.unclosed) unclosed = true;
    if (range.preambleRemoved) preambleRemoved = true;
  }
  output += input.slice(cursor);
  const text = /^\s*$/.test(output) ? '' : output.replace(/^\n+/, '').replace(/\n+$/, '');
  return {
    text,
    removedCount: ranges.length,
    unclosed,
    preambleRemoved,
    retainedReasons,
  };
}

function findStripRanges(input: string, family: EnvelopeFamily): StripRange[] {
  const ranges: StripRange[] = [];
  let index = 0;
  while (index < input.length) {
    const openAt = input.indexOf(family.open, index);
    if (openAt === -1) break;
    if (classifyOpen(input, openAt) !== 'candidate') {
      index = openAt + family.open.length;
      continue;
    }
    const afterOpen = openAt + family.open.length;
    const closeAt = findMatchingClose(input, afterOpen, family.close, openAt);
    if (closeAt === -1 && !isFingerprinted(input, openAt, family)) {
      index = afterOpen;
      continue;
    }
    const end = closeAt === -1 ? input.length : closeAt + family.close.length;
    const preambleStart = matchingPreambleStart(input, openAt, family);
    ranges.push({
      start: preambleStart ?? openAt,
      end,
      unclosed: closeAt === -1,
      preambleRemoved: preambleStart !== undefined,
    });
    index = end;
  }
  return ranges;
}

function collectRetainReasons(
  input: string,
  ranges: StripRange[],
  family: EnvelopeFamily,
): SystemMessageRetainReason[] {
  const reasons: SystemMessageRetainReason[] = [];
  let index = 0;
  while (index < input.length) {
    const openAt = input.indexOf(family.open, index);
    if (openAt === -1) break;
    const next = openAt + family.open.length;
    if (ranges.some((range) => openAt >= range.start && openAt < range.end)) {
      index = next;
      continue;
    }
    const decision = classifyOpen(input, openAt);
    if (decision === 'candidate') {
      reasons.push('unclosed-no-fingerprint');
    } else {
      reasons.push(decision);
    }
    index = next;
  }
  return reasons;
}

function findMatchingClose(
  input: string,
  afterOpen: number,
  close: string,
  openAt: number,
): number {
  let searchFrom = afterOpen;
  while (searchFrom < input.length) {
    const closeAt = input.indexOf(close, searchFrom);
    if (closeAt === -1) return -1;
    if (!isCitedCloser(input, closeAt, openAt)) return closeAt;
    searchFrom = closeAt + close.length;
  }
  return -1;
}

function classifyOpen(input: string, openAt: number): EnvelopeTagContext {
  if (isInsideFence(input, openAt)) return 'fence';
  const prefix = input.slice(lineStartIndex(input, openAt), openAt);
  if (backtickCount(prefix) % 2 === 1) return 'code-span';
  if (prefix.length > 0 && !/^\s*$/.test(prefix)) return 'mid-line';
  return 'candidate';
}

function expandStripRange(input: string, range: StripRange): StripRange {
  const lineStart = lineStartIndex(input, range.start);
  if (lineStart < range.start && /^\s*$/.test(input.slice(lineStart, range.start))) {
    return { ...range, start: lineStart };
  }
  return range;
}

function isCitedCloser(input: string, closeAt: number, openAt: number): boolean {
  const decision = classifyOpen(input, closeAt);
  switch (decision) {
    case 'candidate':
      return false;
    case 'fence':
    case 'code-span':
      return true;
    case 'mid-line':
      return lineStartIndex(input, closeAt) !== lineStartIndex(input, openAt);
    default: {
      const _exhaustive: never = decision;
      throw new Error(`unhandled closer classification ${_exhaustive}`);
    }
  }
}

function isFingerprinted(input: string, openAt: number, family: EnvelopeFamily): boolean {
  const afterOpen = openAt + family.open.length;
  for (const shape of family.shapes) {
    if (shape.afterOpen) {
      const windowChars = shape.windowChars ?? 64;
      if (shape.afterOpen.test(input.slice(afterOpen, afterOpen + windowChars))) {
        return true;
      }
    }
    if (shape.precedingLinePrefix) {
      const previous = previousLine(input, openAt);
      if (previous !== undefined && previous.trimStart().startsWith(shape.precedingLinePrefix)) {
        return true;
      }
    }
  }
  return false;
}

function matchingPreambleStart(
  input: string,
  openAt: number,
  family: EnvelopeFamily,
): number | undefined {
  const previousStart = previousLineStart(input, openAt);
  if (previousStart === undefined) return undefined;
  const previous = previousLine(input, openAt);
  if (previous === undefined) return undefined;
  for (const shape of family.shapes) {
    if (
      shape.precedingLinePrefix &&
      previous.trimStart().startsWith(shape.precedingLinePrefix)
    ) {
      return previousStart;
    }
  }
  return undefined;
}

function lineStartIndex(input: string, index: number): number {
  return input.lastIndexOf('\n', index - 1) + 1;
}

function previousLineStart(input: string, openAt: number): number | undefined {
  const currentLineStart = lineStartIndex(input, openAt);
  if (currentLineStart === 0) return undefined;
  return lineStartIndex(input, currentLineStart - 1);
}

function previousLine(input: string, openAt: number): string | undefined {
  const currentLineStart = lineStartIndex(input, openAt);
  if (currentLineStart === 0) return undefined;
  return input.slice(lineStartIndex(input, currentLineStart - 1), currentLineStart - 1);
}

interface FenceOpen {
  char: '`' | '~';
  length: number;
}

function parseFenceLine(line: string): { char: '`' | '~'; length: number; info: string } | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return undefined;
  const marker = match[2];
  const char = marker[0];
  if (char !== '`' && char !== '~') return undefined;
  const info = match[3];
  if (char === '`' && info.includes('`')) return undefined;
  return { char, length: marker.length, info };
}

function isInsideFence(input: string, index: number): boolean {
  const before = input.slice(0, lineStartIndex(input, index));
  if (before.length === 0) return false;
  let active: FenceOpen | undefined;
  for (const line of before.split('\n')) {
    const parsed = parseFenceLine(line);
    if (!parsed) continue;
    if (active === undefined) {
      active = { char: parsed.char, length: parsed.length };
      continue;
    }
    if (
      parsed.char === active.char &&
      parsed.length >= active.length &&
      parsed.info.trim() === ''
    ) {
      active = undefined;
    }
  }
  return active !== undefined;
}

function backtickCount(text: string): number {
  let count = 0;
  for (const char of text) {
    if (char === '`') count += 1;
  }
  return count;
}
