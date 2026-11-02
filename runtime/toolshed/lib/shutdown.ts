/**
 * Runs the steps of a shutdown, and returns the status the process exits
 * with: `0` when they finish within `limitMs`, and `1` when one of them
 * throws or they are still running at the limit. A failure is logged as an
 * error.
 */
export async function runShutdown(
  steps: () => Promise<void>,
  limitMs: number,
): Promise<number> {
  const { promise: limit, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => reject(new Error("Shutdown timed out")),
    limitMs,
  );
  try {
    await Promise.race([steps(), limit]);
    return 0;
  } catch (failure) {
    console.error("Error during shutdown:", failure);
    return 1;
  } finally {
    clearTimeout(timer);
  }
}
