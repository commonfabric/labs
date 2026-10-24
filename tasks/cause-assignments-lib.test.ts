import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  assignmentDigest,
  assignmentLevels,
  movedCells,
  type PatternAssignment,
} from "./cause-assignments-lib.ts";

/** A built pattern's fields, as far as the cause assignment reads them. */
interface Built {
  argumentSchema: unknown;
  result: unknown;
  nodes: unknown[];
  derivedInternalCells: unknown[];
}

// The alias a node's binding holds for the internal cell `partialCause`.
const alias = (partialCause: unknown) => ({
  $alias: { partialCause, path: [] },
});

// A child pattern, with no cells of its own, and the identity it is known by.
const child = (): Built => ({
  argumentSchema: {},
  result: {},
  nodes: [],
  derivedInternalCells: [],
});
const CHILD = child();
const OTHER_CHILD = child();
const entryRefOf = (artifact: object) =>
  artifact === CHILD
    ? { identity: "child-identity", symbol: "Child" }
    : artifact === OTHER_CHILD
    ? { identity: "child-identity", symbol: "Other" }
    : undefined;

/** The parts a test pattern is made of, each taking the next number. */
type Part =
  | { lift: true; schema?: unknown }
  | { child: Built }
  | { stream: true }
  | { seeded: true };

/**
 * A pattern holding `parts`, numbered in order, where `named` gives a
 * part's index the instance name it takes in place of its number.
 */
function built(parts: readonly Part[], named: Map<number, string> = new Map()) {
  const nodes: unknown[] = [];
  const cells: unknown[] = [];
  parts.forEach((part, number) => {
    const generated: Record<string, unknown> = "stream" in part
      ? { $generated: number, $kind: "stream" }
      : { $generated: number };
    const name = named.get(number);
    const partialCause = name === undefined ? generated : { $instance: name };
    cells.push({
      partialCause,
      ...(name !== undefined && { legacyPartialCause: generated }),
      ...(("lift" in part || "child" in part) && { kind: "computed" }),
      ...("lift" in part && part.schema !== undefined &&
        { schema: part.schema }),
    });
    if ("lift" in part) {
      nodes.push({
        module: { type: "javascript" },
        inputs: {},
        outputs: alias(partialCause),
      });
    } else if ("child" in part) {
      nodes.push({
        module: { type: "pattern", implementation: part.child },
        inputs: {},
        outputs: alias(partialCause),
      });
    }
  });
  return {
    argumentSchema: {},
    result: {},
    nodes,
    derivedInternalCells: cells,
  };
}

const assignment = (
  parts: readonly Part[],
  named?: Map<number, string>,
): PatternAssignment => ({
  pattern: "test.tsx",
  source: "source",
  levels: assignmentLevels(built(parts, named), entryRefOf),
});

describe("cause-assignments-lib", () => {
  describe("assignmentLevels()", () => {
    it("returns each numbered cell with what writes it, and whether it holds state", () => {
      expect(
        assignmentLevels(
          built([{ lift: true }, { child: CHILD }, { stream: true }, {
            seeded: true,
          }]),
          entryRefOf,
        )[0].cells,
      ).toEqual([
        {
          number: 0,
          description: "cell, computed, written by function",
          holdsState: false,
        },
        {
          number: 1,
          description:
            "cell, computed, written by sub-pattern child-identi#Child",
          holdsState: true,
        },
        {
          number: 2,
          description: "stream, not computed, no writer",
          holdsState: false,
        },
        {
          number: 3,
          description: "cell, not computed, no writer",
          holdsState: true,
        },
      ]);
    });

    it("returns a named instance's cell under its legacy number", () => {
      expect(
        assignmentLevels(
          built([{ lift: true }, { child: CHILD }], new Map([[1, "a"]])),
          entryRefOf,
        )[0].cells.map((cell) => cell.number),
      ).toEqual([0, 1]);
    });

    it("returns a level for each child pattern, keyed by the writers leading to it rather than by a number", () => {
      const keys = (parts: readonly Part[]) =>
        assignmentLevels(built(parts), entryRefOf).map((level) => level.key);

      expect(keys([{ lift: true }, { child: CHILD }])).toEqual([
        "",
        "/sub-pattern child-identi#Child[0]#0",
      ]);
      expect(keys([{ child: CHILD }])).toEqual(keys([{ lift: true }, {
        child: CHILD,
      }]));
    });

    it("returns no level for a value that is not a pattern", () => {
      expect(assignmentLevels({ nodes: "none" }, entryRefOf)).toEqual([]);
    });
  });

  describe("movedCells()", () => {
    it("returns a child that a removed lift ahead of it moves to a lower number", () => {
      expect(
        movedCells(
          assignment([{ lift: true }, { child: CHILD }, { stream: true }]),
          assignment([{ child: CHILD }, { stream: true }]),
        ),
      ).toEqual([
        {
          pattern: "test.tsx",
          level: "",
          description:
            "cell, computed, written by sub-pattern child-identi#Child",
          holdsState: true,
          from: 1,
          to: 0,
        },
        {
          pattern: "test.tsx",
          level: "",
          description: "stream, not computed, no writer",
          holdsState: false,
          from: 2,
          to: 1,
        },
      ]);
    });

    it("returns nothing for two builds that number every cell alike", () => {
      const parts: Part[] = [{ lift: true }, { child: CHILD }, {
        stream: true,
      }];

      expect(movedCells(assignment(parts), assignment(parts))).toEqual([]);
    });

    it("returns nothing for two builds that differ only in a cell's schema", () => {
      expect(
        movedCells(
          assignment([{ lift: true, schema: { type: "number" } }, {
            child: CHILD,
          }]),
          assignment([{ lift: true, schema: { type: "string" } }, {
            child: CHILD,
          }]),
        ),
      ).toEqual([]);
    });

    it("returns nothing for two builds that differ only in naming an instance", () => {
      const parts: Part[] = [{ lift: true }, { child: CHILD }];

      expect(
        movedCells(assignment(parts), assignment(parts, new Map([[1, "a"]]))),
      ).toEqual([]);
    });

    it("returns each of two children of one pattern, matched to the other build by their order", () => {
      expect(
        movedCells(
          assignment([{ lift: true }, { child: CHILD }, { child: CHILD }]),
          assignment([{ child: CHILD }, { child: CHILD }]),
        ).map(({ from, to }) => [from, to]),
      ).toEqual([[1, 0], [2, 1]]);
    });

    it("returns two children of different patterns that trade numbers", () => {
      expect(
        movedCells(
          assignment([{ child: CHILD }, { child: OTHER_CHILD }]),
          assignment([{ child: OTHER_CHILD }, { child: CHILD }]),
        ).map(({ description, from, to }) => [description.slice(-5), from, to]),
      ).toEqual([["Other", 1, 0], ["Child", 0, 1]]);
    });
  });

  describe("assignmentDigest()", () => {
    it("returns one digest for two alike builds, and another for a build that numbers a cell differently", () => {
      const digest = (parts: readonly Part[]) =>
        assignmentDigest(assignment(parts));
      const alike = digest([{ lift: true }, { child: CHILD }]);

      expect(digest([{ lift: true }, { child: CHILD }])).toBe(alike);
      expect(digest([{ child: CHILD }, { lift: true }])).not.toBe(alike);
    });
  });
});
