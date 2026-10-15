import { describe, expect, it } from 'vitest';
import { BoundedStderr, STDERR_SEGMENT_BYTES } from '../../../src/agent/runner/bounded-stderr';

const FIFTY_MB = 50 * 1024 * 1024;

describe('BoundedStderr', () => {
  it('keeps a 50 MB stream to head+tail segments and retains both ends', () => {
    const buf = new BoundedStderr();
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    let remaining = FIFTY_MB;
    let first = true;
    while (remaining > 0) {
      const size = Math.min(chunk.length, remaining);
      const piece = size === chunk.length ? chunk : chunk.subarray(0, size);
      if (first) {
        piece.write('HEAD-MARKER');
        first = false;
      }
      if (remaining === size) {
        Buffer.from('TAIL-MARKER').copy(piece, piece.length - 'TAIL-MARKER'.length);
      }
      buf.push(piece);
      remaining -= size;
    }

    expect(buf.retainedBytes).toBeLessThanOrEqual(STDERR_SEGMENT_BYTES * 2);
    expect(buf.retainedBytes).toBeGreaterThan(STDERR_SEGMENT_BYTES);
    expect(buf.totalBytes).toBe(FIFTY_MB);
    const snapshot = buf.snapshot();
    expect(snapshot.startsWith('HEAD-MARKER')).toBe(true);
    expect(snapshot.endsWith('TAIL-MARKER')).toBe(true);
    expect(Buffer.byteLength(snapshot)).toBeLessThanOrEqual(STDERR_SEGMENT_BYTES * 2 + 8);
  });

  it('returns the full stream when it fits in the bound', () => {
    const buf = new BoundedStderr();
    buf.push(Buffer.from('hello\n'));
    buf.push(Buffer.from('world'));
    expect(buf.snapshot()).toBe('hello\nworld');
    expect(buf.retainedBytes).toBe(11);
  });
});
