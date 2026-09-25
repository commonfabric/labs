/**
 * How a reader knows CI measuring its own run from a test.
 *
 * A lane measures its own setup and its own batches, and the job that
 * scores a run's coverage writes what the run's tests covered, through the
 * record machinery every test uses, so those measurements arrive as
 * ordinary records and travel the same path. They are not test surfaces:
 * nothing enumerates them, nothing scores them, and no lane can be asked to
 * run one. Every reader that asks where a record belongs asks this first,
 * and it is here beside the record schema so that a reader outside the
 * lane's own package can.
 *
 * `tasks/lane-measurement.ts` composes the lane's own names, and
 * {@link coverageRecords} the coverage ones.
 */

import type { TestIdentity, TestRecord } from "./schema.ts";

/** The record surface the lane measures itself on. */
export const LANE_MEASUREMENT_SURFACE = { kind: "gate", scope: "ci" };

/** What the lane's own measurements are named for. */
export const LANE_MEASUREMENT_PREFIX = "ci-lane ";

/** Whether an identity is CI measuring its own run rather than a test. */
export function isLaneMeasurement(test: TestIdentity): boolean {
  return test.k === LANE_MEASUREMENT_SURFACE.kind &&
    test.s === LANE_MEASUREMENT_SURFACE.scope &&
    test.n.startsWith(LANE_MEASUREMENT_PREFIX);
}

/** What a run's coverage measurements are named for. */
const COVERAGE_PREFIX = `${LANE_MEASUREMENT_PREFIX}coverage `;

/** The name of the measurement saying the run's compile cache was cold. */
const COLD = `${COVERAGE_PREFIX}cold`;

/**
 * What a run measured of the repository's test coverage. Each count is a
 * number of uncovered lines, which the record carrying it holds as its
 * `durationMs`.
 */
export interface CoverageFigures {
  /**
   * Per source group, scored over every report the run's tests wrote:
   * `workspace` for the whole repository, a top-level directory such as
   * `tasks`, or a package such as `packages/runner`.
   */
  groups: ReadonlyMap<string, number>;

  /**
   * Per measured set, named `<suite>/<member>`: one suite's tests over one
   * workspace member's lines.
   */
  sets: ReadonlyMap<string, number>;

  /**
   * Whether the pattern compile byte cache the run's tests opened was not
   * restored. A cold cache reaches compile branches a warm one does not,
   * which lowers the group figures.
   */
  cold: boolean;
}

/** The records a run's coverage figures are written as. */
export function coverageRecords(figures: CoverageFigures): TestRecord[] {
  const record = (name: string, uncoveredLines: number): TestRecord => ({
    line: "record",
    test: {
      k: LANE_MEASUREMENT_SURFACE.kind,
      s: LANE_MEASUREMENT_SURFACE.scope,
      n: name,
    },
    outcome: "pass",
    durationMs: uncoveredLines,
  });
  return [
    ...[...figures.groups].map(([group, lines]) =>
      record(`${COVERAGE_PREFIX}group ${group}`, lines)
    ),
    ...[...figures.sets].map(([set, lines]) =>
      record(`${COVERAGE_PREFIX}set ${set}`, lines)
    ),
    ...(figures.cold ? [record(COLD, 0)] : []),
  ];
}

/**
 * The coverage figures a run's records hold. A later record's figure for a
 * name replaces an earlier one's, and records of anything else are passed
 * over, so a run with none holds no figure.
 */
export function coverageFiguresOf(
  records: Iterable<TestRecord>,
): CoverageFigures {
  const groups = new Map<string, number>();
  const sets = new Map<string, number>();
  let cold = false;
  for (const { test, durationMs } of records) {
    if (!isLaneMeasurement(test) || !test.n.startsWith(COVERAGE_PREFIX)) {
      continue;
    }
    const rest = test.n.slice(COVERAGE_PREFIX.length);
    const space = rest.indexOf(" ");
    const name = rest.slice(space + 1);
    if (rest === "cold") cold = true;
    else if (space < 0 || name.length === 0) continue;
    else if (rest.startsWith("group ")) groups.set(name, durationMs);
    else if (rest.startsWith("set ")) sets.set(name, durationMs);
  }
  return { groups, sets, cold };
}

/**
 * The name a job shipping a run's coverage measurements gives its artifact,
 * which the relay names the stored object after. That is what lets a reader
 * find a day's measurements by listing for {@link COVERAGE_OBJECT_GLOB}
 * rather than by reading the whole day.
 */
export const COVERAGE_ARTIFACT = "coverage";

/**
 * A glob matching the name of every object the relay stores from a
 * {@link COVERAGE_ARTIFACT} artifact, whichever run and attempt produced it.
 */
export const COVERAGE_OBJECT_GLOB =
  `**/run-*-test-records-${COVERAGE_ARTIFACT}-a[0-9]*.ndjson`;

/**
 * The attempt that uploaded an artifact named for {@link COVERAGE_ARTIFACT}
 * by the shipping action, as `test-records-coverage-a<attempt>`, or
 * `undefined` for any other name.
 */
export function coverageArtifactAttempt(name: string): number | undefined {
  const match = name.match(
    new RegExp(`^test-records-${COVERAGE_ARTIFACT}-a(\\d+)$`),
  );
  return match === null ? undefined : Number(match[1]);
}
