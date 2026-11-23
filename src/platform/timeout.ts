/**
 * `work`, or `fallback` once `timeoutMs` passes without it settling. A
 * rejected `work` also resolves to `fallback`; the caller owns any logging.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = work.then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const }),
  );
  try {
    const winner = await Promise.race([
      settled,
      new Promise<{ ok: false }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return winner.ok ? winner.value : fallback;
  } finally {
    clearTimeout(timer);
  }
}
