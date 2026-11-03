import { isBrowser } from "@commonfabric/platform/env";
import { yieldToEventLoop } from "@commonfabric/async/sleep";

/**
 * Whether cold pattern compilation yields real macrotask turns between its
 * steps (per-module transform/emit, per-body SES verify, per-module evaluate)
 * when nothing says otherwise.
 *
 * Yielding lets work sharing the SAME event loop interleave with the CPU-bound
 * compile. In the browser runtime worker that work is IPC, and a synchronous
 * compile stalls every queued delivery for the whole compile (measured
 * `runner.loop/workerLag` ~1.6s on a cold space-root compile). A serving runtime
 * has the same need and turns this on for itself (`EngineOptions`): the waves of
 * every other space on its thread wait for the compile, and in a serving worker
 * so does the heartbeat its watchdog listens for (serving-loop.md §2).
 *
 * Every other runtime in Deno compiles as a BATCH step — `cf test`, the CLI —
 * with nothing latency-sensitive sharing its loop, so each yield is pure
 * macrotask overhead. Left on, it ~doubles the pattern unit-test wall time. So
 * the default yields in the browser and runs straight through the synchronous
 * driver in Deno.
 *
 * Evaluated once at module load; the runtime environment does not change.
 */
export const COMPILE_INTERLEAVES_EVENT_LOOP = isBrowser();

/**
 * One compile-pipeline yield point: a real macrotask turn where compilation
 * interleaves the event loop, and a plain microtask completion — zero added
 * event-loop turns — everywhere else. An engine's seams between CPU-bound compile
 * steps (per-body SES verify, per-module evaluate) reach it through
 * `Engine.yieldBetweenCompileSteps()`, which says which of the two applies.
 *
 * The default arm is {@link COMPILE_INTERLEAVES_EVENT_LOOP}, so tests can pin
 * both behaviors from Deno: the interleaved arm (yield behind queued tasks) and
 * the batch arm (no macrotask — the sync-driver contract the pattern unit suites
 * rely on).
 */
export async function interleaveCompileYield(
  interleave: boolean = COMPILE_INTERLEAVES_EVENT_LOOP,
): Promise<void> {
  if (interleave) await yieldToEventLoop();
}

/**
 * Turns at a cold compile, one at a time in the order they are taken, for the
 * runtimes that share one instance. A compile that yields lets another runtime
 * read the byte cache while it runs, and without a turn to wait for that runtime
 * would read a miss and compile the same modules again.
 */
export class CompileTurns {
  #last: Promise<void> = Promise.resolve();

  /** Waits for every earlier turn to end; returns what ends this one. */
  async take(): Promise<() => void> {
    const { promise: ended, resolve: end } = Promise.withResolvers<void>();
    const previous = this.#last;
    this.#last = ended;
    await previous;
    return end;
  }
}
