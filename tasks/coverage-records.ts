/**
 * How a run's coverage figures reach the record store. The job that scores
 * them appends them to its record spool as measurements, its shipping step
 * gathers them with the spool, and the relay stores them under the context
 * it composes for the job. `docs/development/COVERAGE.md` says who reads
 * them.
 */

import {
  coverageRecords,
  type Environment,
  FragmentWriter,
} from "@commonfabric/test-support/records";
import {
  coverageMetricGroupName,
  coverageMetricMeasuredSet,
} from "./ci-check-lib.ts";

/**
 * Appends a run's coverage metrics to the spool `env` names. Each metric is
 * sorted into a source group or a measured set by its name, and one naming
 * neither is left out. Nothing is written where `env` names no spool, or
 * where no metric is a figure. A write that fails in the spool warns, as
 * every producer's does, and fails nothing.
 *
 * The environment is the caller's to give: a test that drives a writer as
 * a library runs inside a recording run of its own, and figures written
 * there would file a fixture's figures as that run's.
 */
export function recordCoverage(
  metrics: Iterable<readonly [string, number]>,
  cold: boolean,
  env: Environment,
): void {
  const groups = new Map<string, number>();
  const sets = new Map<string, number>();
  for (const [metric, uncoveredLines] of metrics) {
    const set = coverageMetricMeasuredSet(metric);
    const group = coverageMetricGroupName(metric);
    if (set !== null) sets.set(set, uncoveredLines);
    else if (group !== null) groups.set(group, uncoveredLines);
  }
  if (groups.size === 0 && sets.size === 0) return;
  const writer = FragmentWriter.openForRun(env);
  if (writer === undefined) return;
  for (const record of coverageRecords({ groups, sets, cold })) {
    writer.append(record);
  }
  writer.close();
}
