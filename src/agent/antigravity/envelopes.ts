export const SYSTEM_MESSAGE_OPEN = '<SYSTEM_MESSAGE>';
export const SYSTEM_MESSAGE_CLOSE = '</SYSTEM_MESSAGE>';

export type SystemMessageRetainReason =
  | 'mid-line'
  | 'code-span'
  | 'fence'
  | 'unclosed-no-fingerprint';

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

export interface SystemMessageScrubResult {
  text: string;
  beforeLength: number;
  afterLength: number;
  removedCount: number;
  unclosed: boolean;
  preambleRemoved: boolean;
  retainedReasons: SystemMessageRetainReason[];
}

interface StripRange {
  start: number;
  end: number;
  unclosed: boolean;
  preambleRemoved: boolean;
}

const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/;

export function scrubSystemMessageEnvelopes(input: string): SystemMessageScrubResult {
  const ranges = findStripRanges(input);
  const retainedReasons = collectRetainReasons(input, ranges);
  if (ranges.length === 0) {
    return {
      text: input,
      beforeLength: input.length,
      afterLength: input.length,
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
    output += input.slice(cursor, range.start);
    cursor = range.end;
    if (range.unclosed) unclosed = true;
    if (range.preambleRemoved) preambleRemoved = true;
  }
  output += input.slice(cursor);
  const text = output.trim();
  return {
    text,
    beforeLength: input.length,
    afterLength: text.length,
    removedCount: ranges.length,
    unclosed,
    preambleRemoved,
    retainedReasons,
  };
}

function findStripRanges(input: string): StripRange[] {
  const ranges: StripRange[] = [];
  let index = 0;
  while (index < input.length) {
    const openAt = input.indexOf(SYSTEM_MESSAGE_OPEN, index);
    if (openAt === -1) break;
    if (classifyOpen(input, openAt) !== 'candidate') {
      index = openAt + SYSTEM_MESSAGE_OPEN.length;
      continue;
    }
    const afterOpen = openAt + SYSTEM_MESSAGE_OPEN.length;
    const closeAt = input.indexOf(SYSTEM_MESSAGE_CLOSE, afterOpen);
    if (closeAt === -1 && !isFingerprinted(input, openAt)) {
      index = afterOpen;
      continue;
    }
    const end = closeAt === -1 ? input.length : closeAt + SYSTEM_MESSAGE_CLOSE.length;
    const preambleStart = matchingPreambleStart(input, openAt);
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

function collectRetainReasons(input: string, ranges: StripRange[]): SystemMessageRetainReason[] {
  const reasons: SystemMessageRetainReason[] = [];
  let index = 0;
  while (index < input.length) {
    const openAt = input.indexOf(SYSTEM_MESSAGE_OPEN, index);
    if (openAt === -1) break;
    const next = openAt + SYSTEM_MESSAGE_OPEN.length;
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

function classifyOpen(input: string, openAt: number): SystemMessageRetainReason | 'candidate' {
  if (fenceCountBefore(input, openAt) % 2 === 1) return 'fence';
  const prefix = input.slice(lineStartIndex(input, openAt), openAt);
  if (backtickCount(prefix) % 2 === 1) return 'code-span';
  if (prefix.length > 0 && !/^\s*$/.test(prefix)) return 'mid-line';
  return 'candidate';
}

function isFingerprinted(input: string, openAt: number): boolean {
  const afterOpen = openAt + SYSTEM_MESSAGE_OPEN.length;
  for (const shape of SYSTEM_MESSAGE_ENVELOPE_SHAPES) {
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

function matchingPreambleStart(input: string, openAt: number): number | undefined {
  const previousStart = previousLineStart(input, openAt);
  if (previousStart === undefined) return undefined;
  const previous = previousLine(input, openAt);
  if (previous === undefined) return undefined;
  for (const shape of SYSTEM_MESSAGE_ENVELOPE_SHAPES) {
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

function fenceCountBefore(input: string, index: number): number {
  const before = input.slice(0, lineStartIndex(input, index));
  if (before.length === 0) return 0;
  let count = 0;
  for (const line of before.split('\n')) {
    if (FENCE_LINE.test(line)) count += 1;
  }
  return count;
}

function backtickCount(text: string): number {
  let count = 0;
  for (const char of text) {
    if (char === '`') count += 1;
  }
  return count;
}
