import {
  getLoggerCountsByKey,
  getTimingStatsBreakdown,
  loggerCountsBreakdownOf,
} from "@commonfabric/logger";

import type { ModuleCompileWorker } from "../harness/module-compile-worker.ts";
import type { ServingLoopDiagnostics } from "./serving-port-protocol.ts";

/**
 * The serving loop's diagnostics, as the realm that runs the loop reports
 * them: this realm's logger counts and timing statistics, and those of
 * `moduleCompiler`, the compile worker its serving runtimes compile in, as of
 * that worker's latest compile and under its prefixed logger names. The
 * worker's timing statistics hold the compiler's own phase timings. Reading
 * them never waits on the worker.
 */
export function servingLoopDiagnostics(
  moduleCompiler?: ModuleCompileWorker,
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
