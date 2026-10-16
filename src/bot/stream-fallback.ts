/**
 * What to post after a failed final stream patch, given text already on screen.
 * Empty means skip the standalone send — the user already has the words.
 * A non-prefix rewrite (tool_result icon change) returns the full body so
 * the final answer is not silently dropped.
 */
export function unseenStreamFallback(full: string, streamedSoFar: string | undefined): string {
  const visible = (streamedSoFar ?? '').trimEnd();
  const body = full.trimEnd();
  if (!visible) return body;
  if (!body) return '';
  if (body === visible) return '';
  if (body.startsWith(visible)) return body.slice(visible.length).replace(/^\s+/, '');
  return body;
}
