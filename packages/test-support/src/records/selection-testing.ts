/**
 * Fixtures the selection format's own tests are written against, and that
 * anything reading a manifest can build one from. A manifest is a large
 * shape, and a test that spells one out whole says less about what it is
 * checking than one that changes the two fields it cares about.
 */

import type { TestIdentity } from "./schema.ts";
import {
  type Calibration,
  type Manifest,
  MANIFEST_SCHEMA_VERSION,
  type ManifestEntry,
} from "./selection.ts";

/** What a fixture entry looks like before a case adjusts it. */
export function sampleEntry(
  test: TestIdentity,
  fields: Partial<ManifestEntry> = {},
): ManifestEntry {
  return {
    test,
    suite: "workspace-unit",
    unit: `packages/${test.s}/test/${test.s}.test.ts`,
    cost: 0.05,
    score: 0.05,
    inputs: { catches: 0, sources: 0, churn: 0 },
    flakeRate: 0,
    repeats: 1,
    ...fields,
  };
}

/** Calibration with everything free, so a case's own costs are the whole. */
export function freeCalibration(): Calibration {
  return { setupCost: {}, suites: {}, prologue: 0 };
}

/** A small, valid manifest. */
export function sampleManifest(fields: Partial<Manifest> = {}): Manifest {
  return {
    schema: MANIFEST_SCHEMA_VERSION,
    generatedAt: "2026-08-20T00:00:00.000Z",
    seed: "01K3SAMPLE",
    commit: "c8893b3a8",
    runs: 12,
    dials: {},
    calibration: freeCalibration(),
    entries: [sampleEntry({ k: "unit", s: "memory", n: "space > writes" })],
    withheld: [],
    unavailable: [],
    unschedulable: [],
    lanes: [],
    known: { count: 1, digest: "0000000000000000" },
    coverageBaselines: [],
    ...fields,
  };
}
