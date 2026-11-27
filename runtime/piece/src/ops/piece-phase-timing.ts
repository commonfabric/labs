/**
 * Phase timing for the piece controller's own code paths. Every phase is
 * recorded in the `piece` logger's timing stats, as `piece/phase/<label>`,
 * which the load summaries show even while the logger is disabled, the
 * browser worker's included. With `CF_CLI_TRACE_TIMINGS=1` each phase is also
 * written to stderr as `[piece-phase] <ms>ms :: <label>`, beside the CLI's own
 * `[cf-phase]` lines (`runtime/cli/lib/trace-timing.ts`).
 */

import { getLogger } from "@commonfabric/logger";

const pieceTimingLogger = getLogger("piece", { enabled: false });

/**
 * Where a phase is written to stderr, and whether it is. The CLI's phases
 * take the same shape.
 */
export interface PhaseTrace {
  readonly enabled: boolean;
  readonly log: (line: string) => void;
}

/**
 * The process-wide trace, read once, since the flag is a property of the
 * process rather than of any one call. Outside Deno, as in a browser worker,
 * there is no environment to read and it is off.
 */
export const piecePhaseTrace: PhaseTrace = {
  enabled: typeof Deno !== "undefined" &&
    Deno.env.get("CF_CLI_TRACE_TIMINGS") === "1",
  log: console.error,
};

/**
 * Runs `run` as one named phase, recording its elapsed time whether it
 * returned or threw, and writing it to `trace` when that is enabled.
 */
export async function timePiecePhase<T>(
  label: string,
  run: () => T | Promise<T>,
  trace: PhaseTrace = piecePhaseTrace,
): Promise<T> {
  const start = performance.now();
  try {
    return await run();
  } finally {
    pieceTimingLogger.time(start, "phase", label);
    if (trace.enabled) {
      const elapsed = Math.round(performance.now() - start);
      trace.log(`[piece-phase] ${elapsed}ms :: ${label}`);
    }
  }
}
