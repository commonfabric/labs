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
  digestIdentities,
  type Manifest,
  MANIFEST_SCHEMA_VERSION,
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
  CoverageBaseline,
  LanePlan,
  Manifest,
  ManifestEntry,
  ScoreInputs,
  SuiteFit,
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
