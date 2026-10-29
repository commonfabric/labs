// The serving scheduler's cooperative macrotask yield (server-execution v2
// stage C tuning, T3; serving-loop.md §2/§3).
//
// Why: the settle loop (`settle.ts`) runs every action of a pass on one
// microtask chain — no macrotask boundary from the first run to the
// last. On a serving runtime that is the wave's whole settle: the
// stage-C attribution
// measured chat event waves of 2.6–3.6 s in which the 100-ms flush
// deadline fired 2.5–8.3 s LATE (`wavesBudgetExhausted` was a symptom,
// not a bound), the lease-renew `setInterval` starved for up to 10 s
// against a 15-s TTL (t2: `wave-commit-rejected` then `lease-lost` on
// every active space within 10 ms — the process's renew timers missing
// together), and the memory server's 5-ms push flush waited too. The
// timers all ride the macrotask queue the loop never yields to.
//
// What: a time-sliced yield. `maybeYield()` is called between runs;
// when the current slice of continuous scheduler work has run longer
// than `sliceMs` it awaits one macrotask turn (`setTimeout(0)` — the one
// primitive that lets DUE timers fire in deadline order before it
// resumes; measured on Deno: a MessageChannel turn or `setImmediate`
// let 0–2 of 8 due timers fire across a 360-ms loop, `setTimeout(0)`
// all 8 within a few ms of their deadlines) and reports the slice to the
// installed observer FIRST, synchronously — the mid-wave lease renew
// rides that hook, so it never depends on the timer queue being
// serviced. Between yields nothing changes: the OFF arm and client
// runtimes never construct one of these (the scheduler creates it only
// under `runtime.servingPosture`), so their settle loops keep the exact
// microtask shape they had.
//
// Bound, stated honestly: the deadline becomes honest to within ONE
// action plus a slice — an action's per-demander instance runs (a
// 250-ms demand walk × its demanders) and its union-log resubscribe
// still run to their end; nothing here shortens the WORK (that is the
// design half of stage C, the per-demander walk). The yield is NOT
// placed inside the fan-out loop (see run.ts's note): a macrotask there
// let a run's own async seal refusal re-enter the pass.

import { getLogger } from "@commonfabric/utils/logger";

const logger = getLogger("cooperative-yield", {
  enabled: true,
  level: "warn",
});

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

  /** The mid-wave hook (the SpaceServer's lease renew): called
   * synchronously at every yield, BEFORE the macrotask turn. */
  onYield: (() => void) | undefined;

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

  /** Yield one macrotask turn unconditionally: report the slice to the
   * observer (synchronously — see the header), then let due timers run. */
  yieldNow(): Promise<void> {
    this.#yields += 1;
    try {
      this.onYield?.();
    } catch (error) {
      // The observer is the serving loop's; a throw there must not take
      // the scheduler down with it (same containment posture as the
      // replica's observer seams).
      logger.warn("yield-observer-failed", () => [
        "cooperative-yield observer threw",
        error,
      ]);
    }
    return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(
      () => {
        this.#sliceStart = performance.now();
      },
    );
  }
}
