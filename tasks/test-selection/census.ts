/**
 * Reading a working tree against a manifest.
 *
 * The tree decides which tests exist and the manifest decides what each
 * of them is worth and costs. Everything that chooses tests reads the
 * result of this rather than the manifest the store gave, so a unit the
 * manifest still names and the tree no longer has cannot be run, and a
 * unit the tree has and no manifest has seen cannot be missed. Both
 * mistakes were reachable while the full run read the tree and the
 * pull-request run read the manifest.
 */

import { testIdentityKey } from "@commonfabric/test-support/records";
import type { TestIdentity } from "@commonfabric/test-support/records";
import {
  type Suite,
  unavailableUnits,
  type Unit,
} from "../test-topology/suite.ts";
import {
  coverageGateFor,
  type CoverageGateSelection,
  measuredUnitKeys,
} from "./coverage.ts";
import {
  emptyManifest,
  type Manifest,
  type ManifestEntry,
} from "./manifest.ts";
import type { SelectionReason } from "./plan.ts";
import { UNMEASURED_COST_SECONDS, VALUE_FLOOR } from "./policy.ts";
import { percentile90 } from "./score.ts";

/** How a stand-in's name is built, and what recognizes one again. */
const UNRECORDED = "unrecorded ";

/**
 * A stand-in identity for a unit no manifest has ever seen. Records exist
 * only for tests that ran, so a unit with none is either brand new or
 * renamed, and both must run. The packer needs something to place, and
 * this is the least it can be given: the suite's own record surface and
 * the unit's path, which no real record will ever collide with because a
 * real record is named for a test rather than for a file.
 */
export function unknownIdentity(suite: Suite, unit: string): TestIdentity {
  const surface = suite.recordSurfaces[0];
  const test: TestIdentity = {
    k: surface?.kind ?? "unit",
    s: surface?.scope ?? "repo",
    n: `${UNRECORDED}${unit}`,
  };
  if (suite.variant !== undefined) test.v = suite.variant;
  return test;
}

/**
 * Whether a manifest entry is a stand-in for a unit no manifest has
 * seen, rather than a real identity some run recorded.
 *
 * A reader that asks which identities a batch accounted for needs this:
 * no record will ever carry a stand-in's name, because a real record is
 * named for a test and a stand-in is named for a file.
 */
export function isStandIn(entry: ManifestEntry): boolean {
  return entry.test.n === `${UNRECORDED}${entry.unit}`;
}

/**
 * What one unit nothing has measured is charged, from what the suite's
 * measured units cost, or nothing where the suite has none: the larger of
 * their mean and their ninetieth percentile.
 *
 * Both readings, because a lane holding one such unit is packed against a
 * single figure and a lane holding twenty against their total, and
 * neither reading covers the other's case. Which of the two is larger is
 * decided by the suite's tail. `docs/specs/test-selection.md` carries the
 * argument, beside what a measured test's own cost is read at.
 */
function standInCost(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((total, one) => total + one, 0) / sorted.length;
  const p90 = percentile90(sorted, sorted.length);
  return Math.max(mean, p90);
}

/**
 * The entry a unit no manifest has ever seen is carried on. Records exist
 * only for tests that ran, so a unit with none is new or renamed, and
 * both have to run.
 *
 * It is charged from what its own suite's units cost, since the suites
 * are orders of magnitude apart — a unit test is milliseconds and a
 * pattern integration test is tens of seconds — so one figure for all of
 * them would misjudge most of them, and a suite's own units are the best
 * evidence there is about what a new one will take.
 *
 * `standInCost` is what that comes to. A suite with nothing measured at
 * all has no such evidence and takes `UNMEASURED_COST_SECONDS`.
 */
export function standIn(
  suite: Suite,
  unit: Unit,
  suiteCosts: readonly number[],
): ManifestEntry {
  return {
    test: unknownIdentity(suite, unit),
    suite: suite.id,
    unit,
    cost: standInCost(suiteCosts) ?? UNMEASURED_COST_SECONDS,
    score: VALUE_FLOOR,
    inputs: { catches: 0, sources: 0, churn: 0 },
    flakeRate: 0,
    flakeEvidence: { flakes: 0, runs: 0 },
    repeats: 1,
  };
}

/**
 * The unit an entry belongs to in this tree.
 *
 * A manifest's `unit` is what its suite said at publication, and a suite
 * that re-grains its units leaves every entry it published naming a unit
 * the tree no longer has. Those entries would be read as covering
 * nothing, and every unit that replaced them as never recorded, so a
 * corpus whose whole history is present would be charged as new until
 * the next publication.
 *
 * So an entry whose stored unit the tree still holds keeps it, and only
 * one whose unit has gone is put back through the suite that owns it.
 * Where the suite cannot place it — its record carries no file, or it
 * belongs to the suite rather than to any unit — the stored unit stands
 * and the entry drops out as before, which is what makes this unable to
 * lose anything that reading the stored value would have kept.
 */
function unitNow(
  suites: ReadonlyMap<string, Suite>,
  held: ReadonlyMap<string, ReadonlySet<Unit>>,
  entry: ManifestEntry,
): Unit {
  if (held.get(entry.suite)?.has(entry.unit) === true) return entry.unit;
  const located = suites.get(entry.suite)?.locate({ test: entry.test });
  return located?.level === "unit" ? located.unit : entry.unit;
}

/** What this working tree holds, and what has to run whatever it is worth. */
export interface Census {
  /**
   * The manifest as this working tree sees it. The tree decides what
   * exists and the manifest decides what each of those things is worth,
   * so a unit the manifest still names and the tree no longer has drops
   * out, and a unit the tree has and the manifest has never seen gets a
   * stand-in. Everything downstream reads this rather than the manifest
   * the store gave, which is what stops the run on `main` and the run on
   * a pull request disagreeing about which tests exist.
   */
  manifest: Manifest;

  /** Identities that run whatever they are worth, against the reason. */
  mandatory: Map<string, SelectionReason>;

  /**
   * How many of the entries are stand-ins, which is how much of what
   * this tree would run rests on a guess at the cost rather than on a
   * measurement. Counted here because this is where the stand-ins are
   * made; asking the manifest whether it arrived answers a different
   * question, since one published before most of this tree existed
   * arrives and still knows almost none of it.
   */
  unmeasured: number;

  /**
   * What the coverage gate decided about this change: the measured sets
   * it runs whole and scores, everything the change reached, and the
   * reason the gate is off where it is. Every consumer reads this rather
   * than working the question out again, so the lane that measures and
   * the job that scores cannot disagree about which sets are gated.
   */
  coverage: CoverageGateSelection;
}

/**
 * Reads the working tree against a manifest.
 *
 * Two rules make a unit mandatory: the change touched what it covers, or
 * no manifest has ever seen it. The second is the rule the test-record
 * spec requires of any consumer that selects which tests run. A selector
 * that never runs the unselected starves its own data, and a renamed test
 * is an unknown identity until an alias lands.
 *
 * The first rule is what the coverage gate rides on. A measured set the
 * change reaches is a declaration saying the change touched what every
 * one of its units covers, so its units are mandatory under the same rule
 * and through the same declaration vocabulary rather than a second one.
 */
export function census(
  suites: readonly Suite[],
  manifest: Manifest | undefined,
  changed: ReadonlySet<string>,
): Census {
  // Everything below writes into the manifest this returns. What it does
  // not touch is what a manifest says about its own publication rather
  // than about a corpus: when it was generated, from which commit and
  // how many runs, the dials it was built with, the exploration seed,
  // the fitted costs, and `known`, which counts what the store has seen
  // and is deliberately the store's figure rather than this tree's.
  const inUnit = new Map<string, ManifestEntry[]>();
  // What each known unit costs in total, which is what a stand-in stands
  // for. A stand-in is a whole unit rather than one test in it, and a
  // unit holds several tests — around seven on average across this
  // repository — so charging it what one test costs would charge a new
  // file a fraction of what running it takes.
  const unitTotal = new Map<string, number>();
  const held = new Map<string, Set<Unit>>(
    suites.map((suite) => [suite.id, new Set(suite.units)]),
  );
  const suiteById = new Map(suites.map((suite) => [suite.id, suite]));
  for (const entry of manifest?.entries ?? []) {
    // The entry carries the unit it was placed under, since everything
    // downstream reads that field rather than the key it was found by.
    const unit = unitNow(suiteById, held, entry);
    const key = `${entry.suite}\t${unit}`;
    const placed = unit === entry.unit ? entry : { ...entry, unit };
    inUnit.set(key, [...inUnit.get(key) ?? [], placed]);
    unitTotal.set(key, (unitTotal.get(key) ?? 0) + entry.cost);
  }
  const costs = new Map<string, number[]>();
  for (const [key, total] of unitTotal) {
    const suite = key.slice(0, key.indexOf("\t"));
    costs.set(suite, [...costs.get(suite) ?? [], total]);
  }
  const coverage = coverageGateFor(suites, changed);
  const measured = measuredUnitKeys(suites, coverage);
  const entries: ManifestEntry[] = [];
  const mandatory = new Map<string, SelectionReason>();
  const taken = new Set<string>(
    (manifest?.entries ?? []).map((entry) => testIdentityKey(entry.test)),
  );
  let unmeasured = 0;
  for (const suite of suites) {
    const unavailable = unavailableUnits(suite);
    // A unit that is a path is made mandatory by the diff naming it. A
    // unit that is not — a type-check group, a repository gate, a
    // binary — is one the suite has to map the diff onto itself,
    // because only it knows what its unit covers.
    const touched = new Set<string>(
      suite.unitsForChange !== undefined
        ? suite.unitsForChange(changed)
        : suite.units.filter((unit) => changed.has(unit)),
    );
    for (const unit of suite.units) {
      if (unavailable.has(unit)) continue;
      // The diff naming the unit outright is the more exact answer, so
      // it is the reason reported where both hold.
      const reason: SelectionReason | undefined = touched.has(unit)
        ? "changed"
        : measured.has(`${suite.id}\t${unit}`)
        ? "coverage-gate"
        : undefined;
      const recorded = inUnit.get(`${suite.id}\t${unit}`);
      if (recorded === undefined) {
        const entry = standIn(suite, unit, costs.get(suite.id) ?? []);
        const key = testIdentityKey(entry.test);
        // A stand-in is named for the unit it stands in for, and a real
        // test could in principle be given that name. Two things would
        // then share one key: the identity maps would keep one of them,
        // and a unit would go into no lane while everything downstream
        // counted as though it had. Nothing here can prevent a name, so
        // the collision is refused where it is made rather than left to
        // be found as a test that stopped running.
        if (taken.has(key)) {
          throw new Error(
            `the stand-in for ${suite.id} ${unit} is named ${key}, and ` +
              `something else in this corpus already is, so one of the ` +
              `two would run nowhere`,
          );
        }
        taken.add(key);
        entries.push(entry);
        unmeasured += 1;
        // Nothing in the manifest runs this unit, so it is unknown
        // whatever else made it mandatory.
        mandatory.set(key, reason ?? "unknown");
        continue;
      }
      entries.push(...recorded);
      if (reason === undefined) continue;
      for (const entry of recorded) {
        mandatory.set(testIdentityKey(entry.test), reason);
      }
    }
  }
  const present = new Set(entries.map((entry) => testIdentityKey(entry.test)));
  return {
    manifest: {
      ...(manifest ?? emptyManifest()),
      entries,
      // An identity held back that this tree cannot run is not something
      // a lane has anything to say about.
      withheld: (manifest?.withheld ?? []).filter((held) =>
        present.has(testIdentityKey(held.test))
      ),
      // What this tree declares unavailable, in place of what the tree
      // the publisher read declared.
      unavailable: suites.flatMap((suite) =>
        suite.unavailable.map((entry) => ({
          suite: suite.id,
          ...(suite.variant === undefined ? {} : { variant: suite.variant }),
          unit: entry.unit,
          ...(entry.leafName === undefined ? {} : { leafName: entry.leafName }),
          ...(entry.phase === undefined ? {} : { phase: entry.phase }),
          reason: entry.reason,
        }))
      ),
      // The publisher's reference packing and its list of what would not
      // fit are over the corpus it read, which is not this one. A plan
      // over these entries works both out again, so carrying the
      // publisher's would be offering an answer to a different question.
      lanes: [],
      unschedulable: [],
    },
    mandatory,
    unmeasured,
    coverage,
  };
}
