import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { testIdentityKey } from "@commonfabric/test-support/records";

import {
  batchMeasurement,
  batchMeasurementName,
  excusedMeasurement,
  excusedMeasurementName,
  LANE_MEASUREMENT_PREFIX,
  laneMeasurement,
  laneMeasurementName,
  setupMeasurement,
} from "./lane-measurement.ts";

/** Every kind of figure a lane writes about a batch. */
const KINDS = [
  "spent",
  "ran",
  "units",
  "longest",
  "passes",
  "start",
  "processes",
  "projected",
] as const;

describe("lane-measurement", () => {
  describe("batchMeasurementName()", () => {
    it("names what a lane spent on a batch", () => {
      expect(batchMeasurementName("workspace-unit", false))
        .toBe("ci-lane batch workspace-unit");
    });

    it("names what a batch's own tests took", () => {
      expect(batchMeasurementName("workspace-unit", false, "ran"))
        .toBe("ci-lane ran batch workspace-unit");
    });

    it("names what the packer charged a lane for a batch", () => {
      expect(batchMeasurementName("workspace-unit", false, "projected"))
        .toBe("ci-lane projected batch workspace-unit");
    });

    it("names a batch run with coverage apart from one run without", () => {
      expect(batchMeasurementName("workspace-unit", true))
        .toBe("ci-lane batch workspace-unit with coverage");
    });
  });

  describe("batchMeasurement()", () => {
    it("returns the suite a spent measurement names", () => {
      expect(batchMeasurement("ci-lane batch workspace-unit")).toEqual({
        suite: "workspace-unit",
        measured: false,
        kind: "spent",
      });
    });

    it("returns the suite a tests-took measurement names", () => {
      expect(batchMeasurement("ci-lane ran batch workspace-unit")).toEqual({
        suite: "workspace-unit",
        measured: false,
        kind: "ran",
      });
    });

    it("returns the suite a longest-unit measurement names", () => {
      expect(batchMeasurement("ci-lane longest batch pattern-unit")).toEqual({
        suite: "pattern-unit",
        measured: false,
        kind: "longest",
      });
    });

    it("returns the suite a pass-count measurement names", () => {
      expect(batchMeasurement("ci-lane passes batch pattern-unit")).toEqual({
        suite: "pattern-unit",
        measured: false,
        kind: "passes",
      });
    });

    it("returns the suite a process setup measurement names, and one a process count names", () => {
      expect(batchMeasurement("ci-lane start batch pattern-unit")).toEqual({
        suite: "pattern-unit",
        measured: false,
        kind: "start",
      });
      expect(batchMeasurement("ci-lane processes batch pattern-unit"))
        .toEqual({ suite: "pattern-unit", measured: false, kind: "processes" });
    });

    it("returns every name `batchMeasurementName()` composes", () => {
      for (const measured of [false, true]) {
        for (const kind of KINDS) {
          const name = batchMeasurementName("runner-unit", measured, kind);
          expect(batchMeasurement(name))
            .toEqual({ suite: "runner-unit", measured, kind });
        }
      }
    });

    it("returns `undefined` for a batch measurement naming no suite", () => {
      expect(batchMeasurement(batchMeasurementName("", false)))
        .toBeUndefined();
      expect(batchMeasurement(batchMeasurementName("", true)))
        .toBeUndefined();
      expect(batchMeasurement(batchMeasurementName("", false, "ran")))
        .toBeUndefined();
    });

    it("composes no name that starts as another kind's does, or as a capability's setup does", () => {
      // A reader that predates a kind tells the kinds apart by these
      // beginnings, so it reads a name of a kind it does not know as no
      // measurement at all, rather than as one of the kinds it does.
      for (const kind of KINDS) {
        const name = batchMeasurementName("runner-unit", false, kind);
        for (const other of KINDS) {
          if (other === kind) continue;
          expect(name.startsWith(batchMeasurementName("", false, other)))
            .toBe(false);
        }
        expect(setupMeasurement(name)).toBeUndefined();
      }
    });

    it("returns `undefined` for a name that is not a batch measurement", () => {
      expect(batchMeasurement("ci-lane setup fuse")).toBeUndefined();
      expect(batchMeasurement("space > writes a fact")).toBeUndefined();
    });
  });

  describe("laneMeasurement()", () => {
    it("returns which of a lane's figures every composed name is", () => {
      for (const kind of ["spent", "projected", "bound"] as const) {
        expect(laneMeasurement(laneMeasurementName(kind))).toBe(kind);
      }
    });

    it("names what a lane spent as `ci-lane lane`", () => {
      expect(laneMeasurementName("spent")).toBe("ci-lane lane");
    });

    it("returns `undefined` for a batch's or a setup's measurement", () => {
      expect(laneMeasurement("ci-lane projected batch workspace-unit"))
        .toBeUndefined();
      expect(laneMeasurement("ci-lane setup fuse")).toBeUndefined();
      expect(laneMeasurement("ci-lane lane ")).toBeUndefined();
    });

    it("is none of a batch's or a setup's measurements", () => {
      // The calibration fits costs from those, and a lane's own total
      // read as one of them would be fitted as a batch.
      for (const kind of ["spent", "projected", "bound"] as const) {
        const name = laneMeasurementName(kind);
        expect(batchMeasurement(name)).toBeUndefined();
        expect(setupMeasurement(name)).toBeUndefined();
      }
    });
  });

  describe("setupMeasurement()", () => {
    it("returns the capability a setup measurement names", () => {
      expect(setupMeasurement(`${LANE_MEASUREMENT_PREFIX}setup fuse`))
        .toBe("fuse");
    });

    it("returns `undefined` for a setup measurement naming no capability", () => {
      expect(setupMeasurement("ci-lane setup ")).toBeUndefined();
    });

    it("returns `undefined` for a name that is not a setup measurement", () => {
      expect(setupMeasurement("ci-lane batch workspace-unit")).toBeUndefined();
    });
  });

  describe("excusedMeasurement()", () => {
    const flaky = testIdentityKey({
      k: "unit",
      s: "bakery",
      n: "glaze > sets",
    });

    it("returns the identity `excusedMeasurementName()` names", () => {
      expect(excusedMeasurement(excusedMeasurementName(flaky))).toBe(flaky);
    });

    it("returns the canonical key for a key written with other spacing", () => {
      // Readers compare keys as strings, so an excusal written in any other
      // spelling of the same identity has to come back canonical.
      const spaced = JSON.stringify(JSON.parse(flaky), null, 1);
      expect(excusedMeasurement(excusedMeasurementName(spaced))).toBe(flaky);
    });

    it("returns `undefined` for an excused measurement naming no identity", () => {
      expect(excusedMeasurement(excusedMeasurementName("glaze > sets")))
        .toBeUndefined();
    });

    it("returns `undefined` for a name that is not an excused measurement", () => {
      expect(excusedMeasurement("ci-lane batch workspace-unit"))
        .toBeUndefined();
      expect(excusedMeasurement(flaky)).toBeUndefined();
    });

    it("is none of a batch's or a setup's measurements", () => {
      // The calibration fits costs from those, and a record of an
      // excusal read as one of them would be fitted as a cost.

      const name = excusedMeasurementName(flaky);
      expect(batchMeasurement(name)).toBeUndefined();
      expect(setupMeasurement(name)).toBeUndefined();
    });
  });
});
