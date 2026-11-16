import {
  getLoggerCountsByKey,
  getTimingStatsBreakdown,
  loggerCountsBreakdownOf,
} from "@commonfabric/logger";

import type { CompileWorkerDiagnostics } from "../harness/module-compile-worker.ts";
import type { ServingLoopDiagnostics } from "./serving-port-protocol.ts";

/**
 * The serving loop's diagnostics, as the realm that runs the loop reports
 * them: this realm's logger counts and timing statistics, and those of
 * `moduleCompiler`, the compile workers its serving runtimes compile in, as of
 * each worker's latest compile and under its prefixed logger names. The
 * workers' timing statistics hold the compiler's own phase timings. Reading
 * them never waits on a worker.
 */
export function servingLoopDiagnostics(
  moduleCompiler?: { diagnostics(): CompileWorkerDiagnostics },
): ServingLoopDiagnostics {
  const worker = moduleCompiler?.diagnostics();
  return {
    loggerCounts: loggerCountsBreakdownOf({
      ...getLoggerCountsByKey(),
      ...worker?.loggerCounts,
    }),
    timingStats: { ...getTimingStatsBreakdown(), ...worker?.timingStats },
  };
}

/**
 * The diagnostics of `compiler`'s compile workers alone, under their prefixed
 * logger names, for a loop whose serving runtimes compile in workers that run
 * outside every serving realm.
 */
export function compileWorkerLoopDiagnostics(
  compiler: { diagnostics(): CompileWorkerDiagnostics },
): ServingLoopDiagnostics {
  const { loggerCounts, timingStats } = compiler.diagnostics();
  return { loggerCounts: loggerCountsBreakdownOf(loggerCounts), timingStats };
}
