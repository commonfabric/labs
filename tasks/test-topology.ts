/**
 * Every test surface the repository has, declared once.
 *
 * A suite says what setup it needs, how to list the things its runner can
 * be pointed at, how to recognize its own records, and what command runs a
 * chosen subset. Nothing else knows about a test surface: the full run's
 * job matrix is computed from here, the lane runner reads the working tree
 * through here, and the publisher scores what this claims. Adding a test,
 * a kind of test, or a configuration of existing tests is a change to a
 * module under `tasks/test-topology/` and never a change to the
 * continuous-integration configuration.
 *
 * `deno task check-test-topology` is what makes that a checked property
 * rather than a hope: one half walks the tree for things that look like
 * tests and fails on any that no suite claims, and the other reads a
 * `main` run's records and fails on any identity no suite recognizes.
 */

import {
  type TestIdentity,
  testIdentityKey,
} from "@commonfabric/test-support/records";
import type { CapabilityId } from "./ci-capabilities.ts";
import { loadBinarySuites } from "./test-topology/binaries.ts";
import { loadCliSuites } from "./test-topology/cli.ts";
import { loadGateSuites } from "./test-topology/gates.ts";
import { loadPackageIntegrationSuites } from "./test-topology/package-integration.ts";
import { loadPatternSuites } from "./test-topology/patterns.ts";
import { loadUnitSuites, RUNS_WHOLE } from "./test-topology/unit.ts";
import type { Suite } from "./test-topology/suite.ts";

export type {
  Enumeration,
  Invocation,
  JUnitOutput,
  LocatableRecord,
  Location,
  RecordSurface,
  Suite,
  Unavailable,
  Unit,
  UnitRequest,
} from "./test-topology/suite.ts";
export { claimsIdentity, fileSuite } from "./test-topology/suite.ts";

/**
 * Every suite, read from a working tree.
 *
 * The suites are built rather than declared, because what a suite can be
 * pointed at is a fact about the tree in front of it: which workspace
 * members exist, which of them can be handed a subset of their own
 * tests, which files each holds. Reading that once and keeping it is
 * what lets `locate` answer without waiting.
 */
export async function loadTopology(
  root: string = Deno.cwd(),
): Promise<Suite[]> {
  return [
    ...await loadGateSuites(root),
    ...await loadUnitSuites(root, RUNS_WHOLE),
    ...await loadPatternSuites(root),
    ...await loadPackageIntegrationSuites(root),
    ...await loadCliSuites(root),
    ...loadBinarySuites(),
  ];
}

/** One suite by its identifier, or undefined for a name nothing declares. */
export function suiteById(
  suites: readonly Suite[],
  id: string,
): Suite | undefined {
  return suites.find((suite) => suite.id === id);
}

/**
 * What each suite needs opened before it can run, which is what the packer
 * charges a lane for the first time it puts one of a suite's identities
 * there.
 */
export function capabilitiesBySuite(
  suites: readonly Suite[],
): Map<string, readonly CapabilityId[]> {
  return new Map(suites.map((suite) => [suite.id, suite.needs]));
}

/**
 * Every unit whose runner runs each identity in it whatever it is asked,
 * written as `<suite>\t<unit>`. The packer places each of these as one choice.
 */
export function wholeUnits(suites: readonly Suite[]): Set<string> {
  return new Set(
    suites.flatMap((suite) =>
      suite.whole.map((unit) => `${suite.id}\t${unit}`)
    ),
  );
}

/** One suite's claim on a record. */
export interface Claim {
  suite: Suite;
  level: "unit" | "suite";

  /** The unit the record belongs to, for a unit-level claim. */
  unit?: string;
}

/**
 * Every suite that recognizes a record. More than one is a topology
 * defect rather than an ambiguity to resolve here, so this reports them
 * all and the drift guard is what fails on the second.
 *
 * A record is matched on its complete identity, the variant included, so
 * an unmarked record reaches only a default suite and a marked one only
 * the suite carrying that exact marker. The same source file may be a
 * unit of a default suite and of a variant suite; those are separate
 * execution surfaces with separate histories.
 */
export function claimsFor(
  suites: readonly Suite[],
  record: { test: TestIdentity; file?: string },
): Claim[] {
  const claims: Claim[] = [];
  for (const suite of suites) {
    const location = suite.locate(record);
    if (location === undefined) continue;
    claims.push(
      location.level === "unit"
        ? { suite, level: "unit", unit: location.unit }
        : { suite, level: "suite" },
    );
  }
  return claims;
}

/** Every unit the topology holds, against the suite that runs it. */
export function topologyUnits(
  suites: readonly Suite[],
): Array<{ suite: Suite; unit: string }> {
  return suites.flatMap((suite) =>
    suite.units.map((unit) => ({ suite, unit }))
  );
}

/**
 * The identities a set of records holds, keyed the way the store keys
 * them. Used by the drift guard and by `plan --verify`, both of which
 * compare a run against what the topology claims.
 */
export function identityKeys(
  records: Iterable<{ test: TestIdentity }>,
): Set<string> {
  const keys = new Set<string>();
  for (const record of records) keys.add(testIdentityKey(record.test));
  return keys;
}
