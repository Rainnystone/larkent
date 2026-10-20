import { stripVTControlCharacters } from 'node:util';

const NODE_NO_COLOR_WARNING =
  /^\(node(?::\d+)?\) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set\.\s*$/;
const NODE_TRACE_HINT =
  /^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\s*$/;

/**
 * Drop the two-line Node warning Grok's tool process prints when it sets both
 * `FORCE_COLOR` and `NO_COLOR`. Parent env cannot stop that injection.
 * Also drop other ANSI/BEL; CRLF is a newline, bare `\r` overwrites a line.
 */
export function stripTerminalText(value: string): string {
  return applyCarriageReturn(stripNodeNoColorWarning(stripVTControlCharacters(value)));
}

export function stripNodeNoColorWarning(value: string): string {
  const lines = value.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!NODE_NO_COLOR_WARNING.test(line)) {
      kept.push(line);
      continue;
    }
    if (NODE_TRACE_HINT.test(lines[i + 1] ?? '')) i += 1;
  }
  return kept.join('\n');
}

/** Normalize CRLF before applying bare `\r` overwrites. BEL is noise. */
function applyCarriageReturn(value: string): string {
  let line = '';
  let out = '';
  for (const ch of value.replace(/\r\n/g, '\n')) {
    if (ch === '\n') {
      out += line + '\n';
      line = '';
    } else if (ch === '\r') {
      line = '';
    } else if (ch !== '\u0007') {
      line += ch;
    }
  }
  return out + line;
}
