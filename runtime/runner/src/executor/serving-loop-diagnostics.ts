import {
  getLoggerCountsBreakdown,
  getTimingStatsBreakdown,
} from "@commonfabric/logger";

import type { ModuleCompileWorker } from "../harness/module-compile-worker.ts";
import type { ServingLoopDiagnostics } from "./serving-port-protocol.ts";

/**
 * The serving loop's diagnostics, as the realm that runs the loop reports
 * them: this realm's logger counts and timing statistics, and the timing
 * statistics of `moduleCompiler`, the compile worker its serving runtimes
 * compile in, which hold the compiler's own phase timings under the worker's
 * prefixed logger names. The compile worker's logger counts are not included.
 *
 * @throws Error, as a rejection, when `moduleCompiler` is closed or its worker
 * dies before it answers.
 */
export async function servingLoopDiagnostics(
  moduleCompiler?: ModuleCompileWorker,
): Promise<ServingLoopDiagnostics> {
  const compileTimings = await moduleCompiler?.timingStats();
  return {
    loggerCounts: getLoggerCountsBreakdown(),
    timingStats: { ...getTimingStatsBreakdown(), ...compileTimings },
  };
}
