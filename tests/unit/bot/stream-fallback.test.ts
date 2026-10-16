import { describe, expect, it } from 'vitest';
import { unseenStreamFallback } from '../../../src/bot/stream-fallback';

describe('unseenStreamFallback', () => {
  it('sends nothing when the stream already showed the full reply', () => {
    expect(unseenStreamFallback('STREAMED_ANSWER', 'STREAMED_ANSWER')).toBe('');
  });

  it('sends only the suffix the stream did not show', () => {
    expect(unseenStreamFallback('SEEN_PARTIALUNSEEN_TAIL', 'SEEN_PARTIAL')).toBe('UNSEEN_TAIL');
  });

  it('does not append a second full copy when the stream text is not a prefix', () => {
    expect(unseenStreamFallback('HELLO WORLD', 'WORLD')).toBe('');
  });
});
