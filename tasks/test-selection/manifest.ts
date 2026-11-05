/**
 * The manifest, as the selection tooling uses it. The format itself lives
 * beside the record schema in `@commonfabric/test-support/records`,
 * because the dashboard reads a manifest as well as the lanes do and one
 * format with two validators would rot. What is here is the one part that
 * cannot live there: the dials a manifest records, which are this
 * repository's policy rather than the format.
 */

import { DIALS } from "./policy.ts";

import {
  type AliasResolver,
  digestIdentities,
  type Manifest,
  MANIFEST_SCHEMA_VERSION,
  type ManifestEntry,
  type SuiteFit,
  type TestIdentity,
  testIdentityKey,
  testIdentityOfKey,
} from "@commonfabric/test-support/records";

export {
  declaredSchema,
  digestIdentities,
  MANIFEST_SCHEMA_VERSION,
  MANIFESTS_LOOKED_BACK,
  parseManifest,
  SELECTION_AREA,
  serializeManifest,
  writtenAhead,
} from "@commonfabric/test-support/records";
export type {
  Calibration,
  CalibrationHealth,
  CoverageBaseline,
  LanePlan,
  Manifest,
  ManifestEntry,
  PreviousSuiteHealth,
  ScoreInputs,
  SuiteFit,
  SuiteHealth,
  UnavailableEntry,
  UnschedulableEntry,
  WithheldEntry,
  WithheldReason,
} from "@commonfabric/test-support/records";

/**
 * The dials as a manifest records them, so a manifest explains its own
 * behavior and two of them can be compared for why they differ.
 */
export function dialSnapshot(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const dial of DIALS) snapshot[dial.name] = dial.value;
  return snapshot;
}

/**
 * A manifest carrying nothing, which is what a working tree is read
 * against when the store has no manifest to give. The tree still decides
 * what runs; what it loses is every figure saying which of its tests are
 * worth more than the others, so all of them are unmeasured and all of
 * them run.
 */
export function emptyManifest(): Manifest {
  return {
    schema: MANIFEST_SCHEMA_VERSION,
    // A fixed moment rather than this one, so that reading a tree twice
    // gives the same manifest both times.
    generatedAt: new Date(0).toISOString(),
    seed: "",
    commit: "",
    runs: 0,
    dials: dialSnapshot(),
    calibration: { setupCost: {}, suites: {}, prologue: 0 },
    entries: [],
    withheld: [],
    unavailable: [],
    unschedulable: [],
    lanes: [],
    known: { count: 0, digest: digestIdentities([]) },
    coverageBaselines: [],
  };
}

/**
 * `manifest` with the alias lines `resolver` holds applied, as of the day the
 * manifest was generated. A publisher moves history to the names alias lines
 * give it, but a manifest published before a line landed still names tests,
 * the files they live in, and workspace members as they were. Applying the
 * lines here prices a renamed test from the history it had under its old name
 * and finds a member's coverage baseline under the member's old directory.
 *
 * An identity that a renamed entry and an entry already under that name both
 * claim keeps the entry already under it.
 */
export function manifestUnderAliases(
  manifest: Manifest,
  resolver: AliasResolver,
): Manifest {
  if (resolver.empty) return manifest;
  const day = manifest.generatedAt.slice(0, 10);
  const test = (identity: TestIdentity) => resolver.resolve(identity, day);
  const path = (text: string) => resolver.resolvePath(text, day);
  const key = (text: string) => {
    const identity = testIdentityOfKey(text);
    return identity === undefined ? text : testIdentityKey(test(identity));
  };
  const fits = (suites: Record<string, SuiteFit>) =>
    Object.fromEntries(
      Object.entries(suites).map(([suite, fit]) => [
        suite,
        fit.unitHooks === undefined ? fit : {
          ...fit,
          unitHooks: Object.fromEntries(
            Object.entries(fit.unitHooks).map(([unit, seconds]) => [
              path(unit),
              seconds,
            ]),
          ),
        },
      ]),
    );

  const byIdentity = new Map<string, ManifestEntry>();
  const renamed: ManifestEntry[] = [];
  for (const entry of manifest.entries) {
    const moved = { ...entry, test: test(entry.test), unit: path(entry.unit) };
    if (testIdentityKey(moved.test) === testIdentityKey(entry.test)) {
      byIdentity.set(testIdentityKey(moved.test), moved);
    } else {
      renamed.push(moved);
    }
  }
  for (const entry of renamed) {
    const identity = testIdentityKey(entry.test);
    if (!byIdentity.has(identity)) byIdentity.set(identity, entry);
  }
  const entries = [...byIdentity.values()];

  return {
    ...manifest,
    calibration: {
      ...manifest.calibration,
      suites: fits(manifest.calibration.suites),
      ...(manifest.calibration.suitesWithCoverage === undefined ? {} : {
        suitesWithCoverage: fits(manifest.calibration.suitesWithCoverage),
      }),
    },
    entries,
    withheld: manifest.withheld.map((entry) => ({
      ...entry,
      test: test(entry.test),
    })),
    unavailable: manifest.unavailable.map((entry) => ({
      ...entry,
      unit: path(entry.unit),
      ...(entry.leafName === undefined
        ? {}
        : { leafName: path(entry.leafName) }),
    })),
    unschedulable: manifest.unschedulable.map((entry) => ({
      ...entry,
      test: test(entry.test),
    })),
    lanes: manifest.lanes.map((lane) => ({
      ...lane,
      batches: lane.batches.map((batch) => ({
        ...batch,
        identities: batch.identities.map(key),
      })),
    })),
    known: {
      count: entries.length,
      digest: digestIdentities(
        entries.map((entry) => testIdentityKey(entry.test)),
      ),
    },
    coverageBaselines: manifest.coverageBaselines.map((baseline) => ({
      ...baseline,
      member: path(baseline.member),
    })),
  };
}
