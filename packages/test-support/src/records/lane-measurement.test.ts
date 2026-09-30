import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { globToRegExp } from "@std/path";

import {
  COVERAGE_ARTIFACT,
  COVERAGE_OBJECT_GLOB,
  coverageArtifactAttempt,
  coverageFiguresOf,
  coverageRecords,
  isLaneMeasurement,
  LANE_MEASUREMENT_PREFIX,
  LANE_MEASUREMENT_SURFACE,
} from "./lane-measurement.ts";
import { ciObjectName, type TestRecord } from "./schema.ts";

describe("lane-measurement", () => {
  describe("isLaneMeasurement()", () => {
    it("returns `true` for every name a lane writes about itself", () => {
      // Spelled out rather than composed, so that what a reader recognizes
      // is pinned against the names themselves. `tasks/lane-measurement.ts`
      // composes them, and its own test holds it to these.

      for (
        const name of [
          "ci-lane batch runner-unit",
          "ci-lane batch workspace-unit with coverage",
          "ci-lane ran batch runner-unit",
          "ci-lane setup fuse",
        ]
      ) {
        expect(isLaneMeasurement({
          k: LANE_MEASUREMENT_SURFACE.kind,
          s: LANE_MEASUREMENT_SURFACE.scope,
          n: name,
        })).toBe(true);
      }
    });

    it("returns `false` for a test on the same surface", () => {
      expect(isLaneMeasurement({
        k: LANE_MEASUREMENT_SURFACE.kind,
        s: LANE_MEASUREMENT_SURFACE.scope,
        n: "repo gates > deno fmt",
      })).toBe(false);
    });

    it("returns `false` for the same name on another surface", () => {
      expect(isLaneMeasurement({
        k: "unit",
        s: "memory",
        n: `${LANE_MEASUREMENT_PREFIX}batch runner-unit`,
      })).toBe(false);
    });
  });

  describe("coverageRecords()", () => {
    const figures = {
      groups: new Map([["workspace", 900], ["packages/bakery", 40]]),
      sets: new Map([["bakery-unit/packages/bakery", 12]]),
      cold: true,
    };

    it("returns records that read back as the figures they were written from", () => {
      expect(coverageFiguresOf(coverageRecords(figures))).toEqual(figures);
      expect(
        coverageFiguresOf(coverageRecords({ ...figures, cold: false })).cold,
      ).toBe(false);
    });

    it("returns records every reader of tests passes over", () => {
      expect(
        coverageRecords(figures).every((record) =>
          isLaneMeasurement(record.test)
        ),
      ).toBe(true);
    });
  });

  describe("coverageArtifactAttempt()", () => {
    it("returns the attempt that uploaded the coverage artifact", () => {
      expect(coverageArtifactAttempt(`test-records-${COVERAGE_ARTIFACT}-a1`))
        .toBe(1);
      expect(coverageArtifactAttempt(`test-records-${COVERAGE_ARTIFACT}-a12`))
        .toBe(12);
    });

    it("returns `undefined` for any other artifact", () => {
      for (
        const name of [
          `test-records-${COVERAGE_ARTIFACT}-api-a1`,
          `test-records-${COVERAGE_ARTIFACT}-a`,
          "test-records-check-a1",
          `${COVERAGE_ARTIFACT}-a1`,
        ]
      ) {
        expect(coverageArtifactAttempt(name)).toBeUndefined();
      }
    });
  });

  describe("coverageFiguresOf()", () => {
    const record = (k: string, n: string, durationMs: number): TestRecord => ({
      line: "record",
      test: { k, s: "ci", n },
      outcome: "pass",
      durationMs,
    });

    it("returns no figure for records of anything else", () => {
      expect(
        coverageFiguresOf([
          record("gate", "ci-lane batch bakery-unit", 90_000),
          record("unit", "ci-lane coverage group workspace", 900),
          record("gate", "ci-lane coverage group ", 900),
        ]),
      ).toEqual({ groups: new Map(), sets: new Map(), cold: false });
    });

    it("returns a later record's figure for a name over an earlier one's", () => {
      expect(
        coverageFiguresOf([
          record("gate", "ci-lane coverage group workspace", 900),
          record("gate", "ci-lane coverage group workspace", 850),
        ]).groups,
      ).toEqual(new Map([["workspace", 850]]));
    });
  });

  describe("COVERAGE_OBJECT_GLOB", () => {
    // The name is the one the relay gives an artifact the shipping action
    // uploads as `test-records-<artifact>-a<attempt>`.
    const stored = (artifact: string, attempt: number) =>
      "labs/test-records/submissions/ci/" + ciObjectName({
        runStartedAt: "2026-09-24T10:00:00Z",
        workflowRunId: "987654",
        artifactName: `test-records-${artifact}-a${attempt}`,
      });
    const matches = (name: string) =>
      globToRegExp(COVERAGE_OBJECT_GLOB, { globstar: true }).test(name);

    it("matches the coverage artifact's object, whichever attempt shipped it", () => {
      expect(matches(stored(COVERAGE_ARTIFACT, 1))).toBe(true);
      expect(matches(stored(COVERAGE_ARTIFACT, 12))).toBe(true);
    });

    it("matches no other artifact's object", () => {
      expect(matches(stored("check", 1))).toBe(false);
      expect(matches(stored(`${COVERAGE_ARTIFACT}-api`, 1))).toBe(false);
      expect(matches(stored(`lane-${COVERAGE_ARTIFACT}`, 1))).toBe(false);
    });
  });
});
