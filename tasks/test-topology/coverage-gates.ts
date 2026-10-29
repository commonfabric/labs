/**
 * The coverage gates: one verdict per measured set, as a suite of its own.
 *
 * A measured set is one suite's units over one workspace member's lines,
 * and the suite that runs those units declares it. Its gate is the
 * comparison of what the set's units reached in that member against what
 * the same set reached on the default branch. No lane runs a gate. A lane
 * runs the set's units with coverage on, and the job that joins the lanes
 * reaches the verdict from the reports they wrote and records it. A gate
 * is still a test in every other sense: it has an identity, a record per
 * run, and a score, and a change runs it when the score chooses it.
 */

import { utf8Compare } from "@commonfabric/utils/utf8";
import { memberScope } from "./unit.ts";
import {
  claimsIdentity,
  coverageMemberDirectory,
  type Judged,
  type MeasuredSet,
  reachedByChange,
  type RecordSurface,
  type Suite,
  unavailableUnits,
} from "./suite.ts";
import {
  type TestIdentity,
  testIdentityKey,
} from "@commonfabric/test-support/records";

/** The suite the coverage gates make up. */
export const COVERAGE_GATE_SUITE = "coverage-gate";

/** One measured set, and the suite that declared it. */
export interface MeasuredSetRef {
  suite: string;
  set: MeasuredSet;
}

/**
 * Every measured set the topology declares that this configuration can
 * run, in a stable order.
 *
 * A set every one of whose units the suite declares unavailable is left
 * out. Keeping it would mean scoring a set nothing ran, so the count
 * would be whatever some other lane happened to leave in the directory.
 */
export function measuredSets(
  suites: readonly Suite[],
): MeasuredSetRef[] {
  const sets: MeasuredSetRef[] = [];
  for (const suite of suites) {
    const unavailable = unavailableUnits(suite);
    for (const set of suite.measured ?? []) {
      if (set.units.every((unit) => unavailable.has(unit))) continue;
      sets.push({ suite: suite.id, set });
    }
  }
  return sets.sort((a, b) =>
    utf8Compare(a.suite, b.suite) || utf8Compare(a.set.member, b.set.member)
  );
}

/**
 * How a measured set is named in a summary or a metric, and which unit of
 * the coverage-gate suite its gate is.
 */
export function measuredSetName(ref: MeasuredSetRef): string {
  return `${ref.suite}/${ref.set.member}`;
}

/** Where one measured set's coverage profiles and report live. */
export function measuredSetDirectory(ref: MeasuredSetRef): string {
  return `${ref.suite}/${coverageMemberDirectory(ref.set.member)}`;
}

/** The measured sets `changed` reaches, in the order `measuredSets()` gives. */
export function reachedSets(
  suites: readonly Suite[],
  changed: ReadonlySet<string>,
): MeasuredSetRef[] {
  return measuredSets(suites)
    .filter((ref) => reachedByChange(ref.set.reachedBy, changed));
}

/**
 * The identity one measured set's gate records under: a gate, owned by the
 * member whose lines it counts, named for the task that judges it and the
 * suite whose units it judges.
 */
export function coverageGateIdentity(ref: MeasuredSetRef): TestIdentity {
  return {
    k: "gate",
    s: memberScope(ref.set.member),
    n: `${COVERAGE_GATE_SUITE} ${ref.suite}`,
  };
}

/**
 * The suite of every measured set's gate in `suites`, one unit for each
 * set, named as `measuredSetName()` names it.
 *
 * A change reaches a gate by the paths its set declares. Each unit judges
 * the units of its set that its suite runs in this configuration. Nothing
 * here builds a command, since no lane runs a gate; a lane asked to run
 * one has been handed a plan that placed a verdict as work, and says so.
 */
export function coverageGateSuite(suites: readonly Suite[]): Suite {
  const refs = measuredSets(suites);
  const byName = new Map(refs.map((ref) => [measuredSetName(ref), ref]));
  const byIdentity = new Map(
    refs.map((ref) => [
      testIdentityKey(coverageGateIdentity(ref)),
      measuredSetName(ref),
    ]),
  );
  const unavailable = new Map(
    suites.map((suite) => [suite.id, unavailableUnits(suite)]),
  );
  const judges = new Map<string, Judged>(
    refs.map((ref) => [measuredSetName(ref), {
      suite: ref.suite,
      units: ref.set.units.filter((unit) =>
        !unavailable.get(ref.suite)?.has(unit)
      ),
      identity: coverageGateIdentity(ref),
    }]),
  );
  const recordSurfaces: RecordSurface[] = [
    ...new Set(refs.map((ref) => memberScope(ref.set.member))),
  ].sort().map((scope) => ({ kind: "gate", scope }));
  const units = [...byName.keys()];
  return {
    id: COVERAGE_GATE_SUITE,
    recordSurfaces,
    needs: [],
    units,
    unavailable: [],
    // Each gate is one identity, and nothing writes it a skip list.
    whole: units,
    judges,
    unitsForChange(changed) {
      return reachedSets(suites, changed).map(measuredSetName);
    },
    locate(record) {
      if (!claimsIdentity({ recordSurfaces }, record.test)) return undefined;
      const unit = byIdentity.get(testIdentityKey(record.test));
      return unit === undefined ? undefined : { level: "unit", unit };
    },
    command(requests) {
      return Promise.reject(
        new Error(
          `a lane was asked to run the coverage gates of ` +
            `${requests.map((request) => request.unit).join(", ")}, and no ` +
            `lane runs a gate: choosing one runs the units it judges`,
        ),
      );
    },
  };
}
