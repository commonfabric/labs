import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fabricFromConvertibleJsValue } from "@commonfabric/data-model";

import type { NumberedCell } from "../src/cause-assignment.ts";
import {
  compareStoredSetupBuild,
  describeHold,
  projectionMap,
  readStoredSetupBuild,
  STORED_SETUP_BUILD_VERSION,
  type StoredSetupBuild,
} from "../src/stored-setup-build.ts";

const PATTERN = { identity: "pattern-identity", symbol: "default" };
const CHILD = "cell, not computed, written by sub-pattern child#default";
const DERIVED = "cell, computed, written by function";

/** A record with the given state list and digests. */
const record = (
  state: [number, string][],
  digests: { cells?: string; projection?: string } = {},
): StoredSetupBuild => ({
  v: STORED_SETUP_BUILD_VERSION,
  pattern: PATTERN,
  cells: digests.cells ?? "cells",
  state,
  projection: digests.projection ?? "projection",
});

/** The numbered cells of a build, each holding state when its description says so. */
const cellsOf = (cells: [number, string][]): NumberedCell[] =>
  cells.map(([number, description]) => ({
    number,
    description,
    holdsState: description !== DERIVED,
  }));

describe("stored-setup-build", () => {
  describe("compareStoredSetupBuild()", () => {
    it("returns `same` when the cell and projection digests agree", () => {
      const stored = record([[0, CHILD]]);

      expect(
        compareStoredSetupBuild(stored, record([[0, CHILD]]), cellsOf([]))
          .kind,
      ).toBe("same");
    });

    it("returns `renumbered` when only cells that hold no state moved", () => {
      const stored = record([[3, CHILD]], { cells: "a" });
      const current = record([[3, CHILD]], { cells: "b" });

      expect(
        compareStoredSetupBuild(
          stored,
          current,
          cellsOf([[0, DERIVED], [3, CHILD]]),
        ),
      ).toEqual({ kind: "renumbered", moved: [] });
    });

    it("returns `held` naming a cell holding state that moved", () => {
      const stored = record([[1, CHILD]], { cells: "a" });
      const current = record([[0, CHILD]], { cells: "b" });

      expect(
        compareStoredSetupBuild(stored, current, cellsOf([[0, CHILD]])),
      ).toEqual({
        kind: "held",
        moved: [{ description: CHILD, holdsState: true, from: 1, to: 0 }],
        ambiguous: [],
      });
    });

    it("returns `held` when cells holding state of one description shrink in count under an equal projection", () => {
      // Three children of one pattern that no result slot links, the
      // leading one dropped: the projection digest is the same, and the
      // pairing by order alone would read the two that remain as unmoved.
      const stored = record([[0, CHILD], [1, CHILD], [2, CHILD]], {
        cells: "a",
      });
      const current = record([[0, CHILD], [1, CHILD]], { cells: "b" });

      expect(
        compareStoredSetupBuild(
          stored,
          current,
          cellsOf([[0, CHILD], [1, CHILD]]),
        ),
      ).toEqual({
        kind: "held",
        moved: [],
        ambiguous: [{ description: CHILD, before: [0, 1, 2], after: [0, 1] }],
      });
    });

    it("returns `held` when the projection changed over cells holding state of one description whose numbers did not", () => {
      // Two cells of one description trading places keep every number, so
      // only the projection can show the trade.
      const stored = record([[2, CHILD], [3, CHILD]], { projection: "a" });
      const current = record([[2, CHILD], [3, CHILD]], { projection: "b" });

      expect(
        compareStoredSetupBuild(
          stored,
          current,
          cellsOf([[2, CHILD], [3, CHILD]]),
        ),
      ).toEqual({
        kind: "held",
        moved: [],
        ambiguous: [{ description: CHILD, before: [2, 3], after: [2, 3] }],
      });
    });

    it("returns `renumbered` when the projection changed over a lone cell holding state that stayed put", () => {
      const stored = record([[2, CHILD]], { projection: "a" });
      const current = record([[2, CHILD]], { projection: "b" });

      expect(
        compareStoredSetupBuild(
          stored,
          current,
          cellsOf([[0, DERIVED], [1, DERIVED], [2, CHILD]]),
        ).kind,
      ).toBe("renumbered");
    });
  });

  describe("projectionMap()", () => {
    it("lists each slot linking a positional cell, by slot path, number and inner path", () => {
      const result = {
        $UI: {
          children: [
            { $alias: { partialCause: { $generated: 1 }, path: [] } },
            { $alias: { partialCause: "named", path: [] } },
            {
              $alias: {
                partialCause: { $generated: 0 },
                path: ["label"],
              },
            },
          ],
        },
      };

      expect(projectionMap(result)).toEqual([
        ["$UI/children/0", 1, ""],
        ["$UI/children/2", 0, "label"],
      ]);
    });
  });

  describe("readStoredSetupBuild()", () => {
    it("returns the record a meta holds", () => {
      const stored = record([[0, CHILD]]);

      expect(readStoredSetupBuild(fabricFromConvertibleJsValue(stored)))
        .toEqual(stored);
    });

    it("returns `undefined` for a record of another version", () => {
      const other = { ...record([]), v: STORED_SETUP_BUILD_VERSION + 1 };

      expect(readStoredSetupBuild(fabricFromConvertibleJsValue(other)))
        .toBeUndefined();
    });

    it("returns `undefined` for a string", () => {
      expect(readStoredSetupBuild("a digest")).toBeUndefined();
    });
  });

  describe("describeHold()", () => {
    it("names each moved cell and each description it could not match", () => {
      expect(
        describeHold(
          [{ description: CHILD, holdsState: true, from: 1, to: 0 }],
          [{ description: CHILD, before: [0, 1, 2], after: [0, 1] }],
        ),
      ).toBe(
        `${CHILD} moved from 1 to 0; cells of one description, ${CHILD}, ` +
          "could not be matched: [0, 1, 2] before, [0, 1] now",
      );
    });

    it("says the piece carries no record when nothing moved", () => {
      expect(describeHold([], [])).toBe(
        "the piece carries no record of the build that set it up, and the " +
          "build has cells holding state",
      );
    });
  });
});
