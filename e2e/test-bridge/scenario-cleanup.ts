/** Always run cleanup, including when the scenario throws. */
export async function runWithCleanup<T>(
  work: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  try {
    return await work();
  } finally {
    await cleanup();
  }
}
