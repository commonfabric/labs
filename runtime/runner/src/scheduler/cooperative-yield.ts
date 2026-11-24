// The serving scheduler's cooperative macrotask yield (server-execution v2
// stage C tuning, T3; serving-loop.md §3).
//
// Why: the settle loop (`settle.ts`) runs every action of a pass on one
// microtask chain — no macrotask boundary from the first run to the
// last. On a serving runtime that is the wave's whole settle: the
// stage-C attribution
// measured chat event waves of 2.6–3.6 s in which the 100-ms flush
// deadline fired 2.5–8.3 s LATE (`wavesBudgetExhausted` was a symptom,
// not a bound), and the memory server's 5-ms push flush waited too. The
// timers all ride the macrotask queue the loop never yields to.
//
// What: a time-sliced yield. `maybeYield()` is called between runs;
// when the current slice of continuous scheduler work has run longer
// than `sliceMs` it awaits one macrotask turn (`setTimeout(0)` — the one
// primitive that lets DUE timers fire in deadline order before it
// resumes; measured on Deno: a MessageChannel turn or `setImmediate`
// let 0–2 of 8 due timers fire across a 360-ms loop, `setTimeout(0)`
// all 8 within a few ms of their deadlines). Between yields nothing
// changes: the scheduler creates one only under `runtime.servingPosture`, so
// the settle loops of the OFF arm and client runtimes keep the exact microtask
// shape they had.
//
// Bound, stated honestly: the deadline becomes honest to within ONE
// action plus a slice — an action's per-demander instance runs (a
// 250-ms demand walk × its demanders) and its union-log resubscribe
// still run to their end; nothing here shortens the WORK (that is the
// design half of stage C, the per-demander walk). The yield is NOT
// placed inside the fan-out loop (see run.ts's note): a macrotask there
// let a run's own async seal refusal re-enter the pass.

/** One frame's worth of continuous scheduler work per macrotask turn on a
 * serving runtime. Sized against the yield's own cost (~2 ms per
 * `setTimeout(0)` on Deno) and the deadline's granularity (T_flush 100
 * ms): ≤ ~12 % overhead on pure-CPU runs, far less on the 20–250-ms
 * demand walks the attribution measured, and a deadline honest to
 * within one run + this slice. */
export const DEFAULT_SERVING_YIELD_SLICE_MS = 16;

export class CooperativeYield {
  readonly #sliceMs: number;
  #sliceStart = performance.now();
  #yields = 0;

  constructor(sliceMs: number = DEFAULT_SERVING_YIELD_SLICE_MS) {
    this.#sliceMs = sliceMs;
  }

  /** DIAGNOSTIC (tests): macrotask turns taken so far. */
  get yieldCount(): number {
    return this.#yields;
  }

  /** The caller just crossed a macrotask boundary of its own (a new
   * execute pass): restart the slice clock so an idle gap does not read
   * as spent work. */
  noteMacrotaskBoundary(): void {
    this.#sliceStart = performance.now();
  }

  /**
   * Yield one macrotask turn iff the current slice is spent. Returns
   * `undefined` when there is nothing to await, so a caller can skip the
   * `await` (and its microtask hop) entirely on the hot path.
   */
  maybeYield(): Promise<void> | undefined {
    if (performance.now() - this.#sliceStart < this.#sliceMs) {
      return undefined;
    }
    return this.yieldNow();
  }

  /** Yield one macrotask turn unconditionally, which lets due timers run. */
  yieldNow(): Promise<void> {
    this.#yields += 1;
    return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(
      () => {
        this.#sliceStart = performance.now();
      },
    );
  }
}
