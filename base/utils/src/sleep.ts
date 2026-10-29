/**
 * Creates a promise that resolves after the specified timeout.
 * @param timeout - The number of milliseconds to wait
 * @returns A promise that resolves after the timeout
 */
export const sleep = (timeout: number) =>
  new Promise((resolve) => setTimeout(resolve, timeout));

/**
 * Detaches a timer from the event loop's ref-count under Deno, via
 * `Deno.unrefTimer()`, so a long-lived background/diagnostic interval never
 * keeps the process alive or trips Deno's `--trace-leaks` op sanitizer when a
 * unit test constructs the owner or imports the module without a matching
 * teardown. No-op in the browser (no `Deno.unrefTimer`), where such timers run
 * for the real worker/connection lifetime and are cleared explicitly on
 * dispose. Returns the id for chaining.
 */
export const unrefTimer = (
  id: ReturnType<typeof setInterval>,
): ReturnType<typeof setInterval> => {
  (globalThis as { Deno?: { unrefTimer(id: number): void } }).Deno
    ?.unrefTimer?.(id as unknown as number);
  return id;
};

/**
 * Creates a promise that rejects after the specified timeout.
 * Useful for racing against long-running operations.
 * @param ms - The number of milliseconds before rejection
 * @param message - The error message for the rejection
 * @returns A promise that rejects after the timeout
 *
 * @example
 * ```ts
 * // Race a fetch against a 5-second timeout
 * const result = await Promise.race([
 *   fetch(url),
 *   timeout(5000, "Request timed out")
 * ]);
 * ```
 */
export const timeout = (ms: number, message: string): Promise<never> =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));

// One macrotask turn through the posted-message task source. Ports are closed
// before resolving so test resource sanitizers see no leak.
const messageYield = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      port2.close();
      resolve();
    };
    port2.postMessage(null);
  });

// How often yieldToEventLoop also routes through the TIMER task source. A
// pure posted-message chain starves timers on some hosts (measured in Deno:
// messages interleave, an armed interval never fires), so periodically pay
// one timer hop to let due timers run. Shared across yielders — it is a
// fairness budget, not a correctness gate.
const TIMER_TURN_BUDGET_MS = 8;
let lastTimerTurnAt = -Infinity;

/**
 * Yields at least one macrotask turn, so tasks already queued on the event
 * loop (worker IPC message events, due timers) run before the continuation.
 *
 * Awaiting an already-resolved promise only yields a MICROtask — queued
 * message events still starve. This posts through a MessageChannel: a real
 * macrotask, and posted-message ordering runs the continuation BEHIND
 * messages that were already queued — which is the interleave long CPU-bound
 * pipelines (e.g. per-module pattern compilation) call this for. Every
 * {@link TIMER_TURN_BUDGET_MS} it additionally takes one setTimeout(0) hop so
 * due timers are not starved by a long message-yield chain; scheduling that
 * timeout from the message callback keeps its nesting level at 1, so the
 * browsers' nested-setTimeout clamp (~4ms per hop past depth 5) never
 * engages.
 */
export const yieldToEventLoop = async (): Promise<void> => {
  if (typeof MessageChannel === "undefined") {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return;
  }
  await messageYield();
  const now = performance.now();
  if (now - lastTimerTurnAt >= TIMER_TURN_BUDGET_MS) {
    lastTimerTurnAt = now;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};
