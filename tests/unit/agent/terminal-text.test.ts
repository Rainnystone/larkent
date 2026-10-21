import { describe, expect, it } from 'vitest';
import { stripTerminalText } from '../../../src/agent/terminal-text';

describe('CLI terminal text line endings', () => {
  it('preserves CRLF as newlines', () => {
    expect(stripTerminalText('first\r\nsecond\r\n')).toBe('first\nsecond\n');
  });
  it('keeps bare carriage return progress overwrites', () => {
    expect(stripTerminalText('first\rsecond\rDONE')).toBe('DONE');
  });
  it('handles CRLF and progress overwrites in the same output', () => {
    expect(stripTerminalText('first\r\n0%\r100%\r\nlast\r\n')).toBe('first\n100%\nlast\n');
  });
});
