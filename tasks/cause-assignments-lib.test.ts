import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  ambiguousCells,
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
const entryRefOf = (artifact: object) =>
  artifact === CHILD
    ? { identity: "child-identity", symbol: "Child" }
    : undefined;

/** The parts a test pattern is made of, each taking the next number. */
type Part = { lift: true } | { child: Built } | { stream: true };

/** A pattern holding `parts`, numbered in order. */
function built(parts: readonly Part[]) {
  const nodes: unknown[] = [];
  const cells: unknown[] = [];
  parts.forEach((part, number) => {
    const partialCause: Record<string, unknown> = "stream" in part
      ? { $generated: number, $kind: "stream" }
      : { $generated: number };
    cells.push({
      partialCause,
      ...(("lift" in part || "child" in part) && { kind: "computed" }),
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

const assignment = (parts: readonly Part[]): PatternAssignment => ({
  pattern: "test.tsx",
  source: "source",
  levels: assignmentLevels(built(parts), entryRefOf),
});

describe("cause-assignments-lib", () => {
  describe("assignmentLevels()", () => {
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
  });

  describe("ambiguousCells()", () => {
    it("returns, with its pattern and level, a description of children whose count differs", () => {
      expect(
        ambiguousCells(
          assignment([{ child: CHILD }, { child: CHILD }, { lift: true }]),
          assignment([{ child: CHILD }, { lift: true }]),
        ),
      ).toEqual([{
        pattern: "test.tsx",
        level: "",
        description:
          "cell, computed, written by sub-pattern child-identi#Child",
        before: [0, 1],
        after: [0],
      }]);
    });

    it("returns nothing for a level only one side has", () => {
      expect(
        ambiguousCells(
          { pattern: "test.tsx", source: "source", levels: [] },
          assignment([{ child: CHILD }]),
        ),
      ).toEqual([]);
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
