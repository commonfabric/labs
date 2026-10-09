/**
 * The records a lane writes about itself, and how everything else knows
 * one when it sees it.
 *
 * A lane measures its own setup and its own batches through the record
 * machinery every test uses, so those measurements arrive as ordinary
 * records and travel the same path. They are not test surfaces: nothing
 * enumerates them, nothing scores them, and no lane can be asked to run
 * one. Every reader that asks the topology where a record belongs asks
 * this first.
 *
 * The surface and the name prefix a measurement is written from come
 * from `@commonfabric/test-support/records`, beside the record schema,
 * so that a reader outside this package recognizes what this composes.
 */

import {
  isLaneMeasurement,
  LANE_MEASUREMENT_PREFIX,
  LANE_MEASUREMENT_SURFACE,
  testIdentityKey,
  testIdentityOfKey,
} from "@commonfabric/test-support/records";

export { isLaneMeasurement, LANE_MEASUREMENT_PREFIX, LANE_MEASUREMENT_SURFACE };

/**
 * How a batch run with coverage on is named apart from one run without.
 *
 * Instrumenting a run costs it time, and how much is a property of the
 * suite rather than a constant, so a measurement records which kind of
 * run it came from.
 */
export const MEASURED_BATCH_SUFFIX = " with coverage";

/** What each of a batch's five measurements is, as its name says it. */
export type BatchMeasurementKind =
  | "spent"
  | "ran"
  | "units"
  | "passes"
  | "projected";

/**
 * The word a measurement's name carries to say which of the five it is.
 * What a batch spent is the one the lane has always written, and it is
 * unmarked. No name a word makes starts the way a name of another kind
 * does, or the way a capability's setup measurement does, so a reader
 * that predates a word reads a name carrying it as no measurement at all
 * rather than as one it knows.
 */
const BATCH_MEASUREMENT_LEAD: Record<BatchMeasurementKind, string> = {
  spent: "",
  ran: "ran ",
  units: "units ",
  passes: "passes ",
  projected: "projected ",
};

/**
 * What a lane's measurement of one batch is called.
 *
 * A lane writes five of these per batch: what the batch spent, what its
 * tests took between them, how many times it opened a unit, how many
 * passes it made, and what the packer charged the lane for the batch. A
 * batch that repeats a unit makes one pass per run, each a fresh
 * invocation of the suite's command over the units still running. The
 * first four are what the calibration is fitted from; the fifth is what
 * says how far the calibration it was charged by was out.
 */
export function batchMeasurementName(
  suite: string,
  measured: boolean,
  kind: BatchMeasurementKind = "spent",
): string {
  return `${LANE_MEASUREMENT_PREFIX}${BATCH_MEASUREMENT_LEAD[kind]}batch ` +
    suite + (measured ? MEASURED_BATCH_SUFFIX : "");
}

/**
 * The suite one batch measurement names, whether coverage was on for it,
 * and which of the five figures it carries. Nothing else for the name: a
 * reader that took it apart itself would be a second answer to how it is
 * composed, and the two would part company the first time either moved.
 *
 * A suite whose id ended with the suffix would be read as a shorter
 * suite's measured run, and the two would be fitted as one.
 * `tasks/test-topology.test.ts` holds the topology to naming no such
 * suite, which is cheaper than escaping every id for a collision no
 * identifier in the tree comes near.
 */
export function batchMeasurement(
  name: string,
):
  | { suite: string; measured: boolean; kind: BatchMeasurementKind }
  | undefined {
  for (
    const kind of [
      "ran",
      "units",
      "passes",
      "projected",
      "spent",
    ] as const
  ) {
    const prefix = `${LANE_MEASUREMENT_PREFIX}` +
      `${BATCH_MEASUREMENT_LEAD[kind]}batch `;
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    const measured = rest.endsWith(MEASURED_BATCH_SUFFIX);
    const suite = measured
      ? rest.slice(0, -MEASURED_BATCH_SUFFIX.length)
      : rest;
    return suite.length === 0 ? undefined : { suite, measured, kind };
  }
  return undefined;
}

/** What each of a lane's three measurements of itself is. */
export type LaneMeasurementKind = "spent" | "projected" | "bound";

/**
 * What a lane's measurement of itself as a whole is called. What it
 * spent is unmarked, as a batch's is.
 */
const LANE_MEASUREMENT_NAMES: Record<LaneMeasurementKind, string> = {
  spent: `${LANE_MEASUREMENT_PREFIX}lane`,
  projected: `${LANE_MEASUREMENT_PREFIX}projected lane`,
  bound: `${LANE_MEASUREMENT_PREFIX}bound lane`,
};

/**
 * What a lane's measurement of its own work is called.
 *
 * A lane writes three of these once its work is done: the seconds from
 * opening its first capability to the end of its own work, what
 * the packer projected those would come to, and the most they may come
 * to before the job is past the bound the lane was packed to finish
 * inside. Together they say whether the lane ran past its bound, and
 * whether the packer expected it to.
 */
export function laneMeasurementName(kind: LaneMeasurementKind): string {
  return LANE_MEASUREMENT_NAMES[kind];
}

/**
 * What a lane of the full run's measurement of its reruns is called: the
 * seconds it spent running again the units holding a test that failed
 * every time its batch ran it. The packer charges nothing for reruns, so
 * what the lane records as its work leaves them out, and this records
 * them apart.
 */
export const RERUN_MEASUREMENT_NAME = `${LANE_MEASUREMENT_PREFIX}reruns`;

/** Which of the three a lane measurement is, from its name. */
export function laneMeasurement(name: string): LaneMeasurementKind | undefined {
  for (const kind of ["spent", "projected", "bound"] as const) {
    if (name === LANE_MEASUREMENT_NAMES[kind]) return kind;
  }
  return undefined;
}

/** The capability one setup measurement names. */
export function setupMeasurement(name: string): string | undefined {
  const prefix = `${LANE_MEASUREMENT_PREFIX}setup `;
  if (!name.startsWith(prefix)) return undefined;
  const capability = name.slice(prefix.length);
  return capability.length === 0 ? undefined : capability;
}

/** What a lane's record of an identity it excused is named for. */
const EXCUSED_PREFIX = `${LANE_MEASUREMENT_PREFIX}excused `;

/**
 * What a lane's record of one excused identity is called: an identity
 * whose failures the lane did not fail the run for, named by its
 * canonical key.
 *
 * A lane writes one for each identity every batch that failed it
 * excused, so that a reader learns what a run did not fail for from the
 * run's own records. The record carries no figure: its `durationMs` is
 * zero, and how often the identity failed is in the identity's own
 * records.
 */
export function excusedMeasurementName(key: string): string {
  return `${EXCUSED_PREFIX}${key}`;
}

/**
 * The canonical key of the identity one excused measurement names, or
 * `undefined` for any other name and for one naming no identity.
 */
export function excusedMeasurement(name: string): string | undefined {
  if (!name.startsWith(EXCUSED_PREFIX)) return undefined;
  const identity = testIdentityOfKey(name.slice(EXCUSED_PREFIX.length));
  return identity === undefined ? undefined : testIdentityKey(identity);
}
