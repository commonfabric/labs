import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  type NumberedCell,
  numberedCells,
  type PatternLevel,
  renumberedCells,
  writerDescription,
} from "../src/cause-assignment.ts";

// The alias a node's binding holds for the internal cell `partialCause`.
const alias = (partialCause: unknown) => ({
  $alias: { partialCause, path: [] },
});

// Two child patterns, which the cause assignment tells apart only by the
// identity `entryRefOf` gives each.
const CHILD = {};
const OTHER_CHILD = {};
const entryRefOf = (artifact: object) =>
  artifact === CHILD
    ? { identity: "child-identity", symbol: "Child" }
    : artifact === OTHER_CHILD
    ? { identity: "child-identity", symbol: "Other" }
    : undefined;

/** The parts a test pattern level is made of, each taking the next number. */
type Part =
  | { lift: true; schema?: unknown }
  | { child: object }
  | { stream: true }
  | { seeded: true };

/**
 * A pattern level holding `parts`, numbered in order, where `named` gives a
 * part's index the instance name it takes in place of its number.
 */
function built(
  parts: readonly Part[],
  named: Map<number, string> = new Map(),
): PatternLevel {
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
  return { nodes, derivedInternalCells: cells };
}

const cells = (
  parts: readonly Part[],
  named?: Map<number, string>,
): NumberedCell[] => numberedCells(built(parts, named), entryRefOf);

describe("cause-assignment", () => {
  describe("writerDescription()", () => {
    it("returns a builtin by its name", () => {
      expect(
        writerDescription(
          { type: "ref", implementation: "ifElse" },
          entryRefOf,
        ),
      ).toBe("builtin ifElse");
    });

    it("returns a function by its wrapper, where it has one", () => {
      expect(writerDescription({ type: "javascript" }, entryRefOf)).toBe(
        "function",
      );
      expect(
        writerDescription(
          { type: "javascript", wrapper: "handler" },
          entryRefOf,
        ),
      ).toBe("function (handler)");
    });

    it("returns a sub-pattern by its child's pattern identity, where one is known", () => {
      expect(
        writerDescription(
          { type: "pattern", implementation: CHILD },
          entryRefOf,
        ),
      ).toBe("sub-pattern child-identi#Child");
      expect(
        writerDescription({ type: "pattern", implementation: {} }, entryRefOf),
      ).toBe("sub-pattern");
      expect(
        writerDescription(
          { type: "pattern", implementation: "not a pattern" },
          entryRefOf,
        ),
      ).toBe("sub-pattern");
    });

    it("returns any other module by its type", () => {
      expect(writerDescription({ type: "passthrough" }, entryRefOf)).toBe(
        "passthrough",
      );
    });
  });

  describe("numberedCells()", () => {
    it("returns each numbered cell with what writes it, and whether it holds state", () => {
      expect(
        cells([{ lift: true }, { child: CHILD }, { stream: true }, {
          seeded: true,
        }]),
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

    it("returns no cell for a cause that carries no `$generated` number, and reads no writer from a node without a module", () => {
      expect(
        numberedCells(
          {
            nodes: [
              "not a node",
              { outputs: alias({ $generated: 0 }) },
              {
                module: { type: "javascript" },
                outputs: alias("result"),
              },
            ],
            derivedInternalCells: [
              "not a descriptor",
              { partialCause: { $generated: 0 }, kind: "computed" },
              { partialCause: "result", kind: "computed" },
              { partialCause: { $instance: "a" }, kind: "computed" },
            ],
          },
          entryRefOf,
        ),
      ).toEqual([{
        number: 0,
        description: "cell, computed, no writer",
        holdsState: false,
      }]);
    });

    it("returns no cell for a level whose fields are not lists", () => {
      expect(
        numberedCells({ nodes: "none", derivedInternalCells: 7 }, entryRefOf),
      )
        .toEqual([]);
    });

    it("returns a named instance's cell under its legacy number", () => {
      expect(
        cells([{ lift: true }, { child: CHILD }], new Map([[1, "a"]])).map((
          cell,
        ) => cell.number),
      ).toEqual([0, 1]);
    });
  });

  describe("renumberedCells()", () => {
    it("returns a child that a removed lift ahead of it moves to a lower number", () => {
      expect(
        renumberedCells(
          cells([{ lift: true }, { child: CHILD }, { stream: true }]),
          cells([{ child: CHILD }, { stream: true }]),
        ),
      ).toEqual([
        {
          description:
            "cell, computed, written by sub-pattern child-identi#Child",
          holdsState: true,
          from: 1,
          to: 0,
        },
        {
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

      expect(renumberedCells(cells(parts), cells(parts))).toEqual([]);
    });

    it("returns nothing for two builds that differ only in a cell's schema", () => {
      expect(
        renumberedCells(
          cells([{ lift: true, schema: { type: "number" } }, {
            child: CHILD,
          }]),
          cells([{ lift: true, schema: { type: "string" } }, {
            child: CHILD,
          }]),
        ),
      ).toEqual([]);
    });

    it("returns nothing for two builds that differ only in naming an instance", () => {
      const parts: Part[] = [{ lift: true }, { child: CHILD }];

      expect(
        renumberedCells(cells(parts), cells(parts, new Map([[1, "a"]]))),
      ).toEqual([]);
    });

    it("returns each of two children of one pattern, matched to the other build by their order", () => {
      expect(
        renumberedCells(
          cells([{ lift: true }, { child: CHILD }, { child: CHILD }]),
          cells([{ child: CHILD }, { child: CHILD }]),
        ).map(({ from, to }) => [from, to]),
      ).toEqual([[1, 0], [2, 1]]);
    });

    it("returns two children of different patterns that trade numbers", () => {
      expect(
        renumberedCells(
          cells([{ child: CHILD }, { child: OTHER_CHILD }]),
          cells([{ child: OTHER_CHILD }, { child: CHILD }]),
        ).map(({ description, from, to }) => [description.slice(-5), from, to]),
      ).toEqual([["Other", 1, 0], ["Child", 0, 1]]);
    });

    describe("with a cell added or removed among cells of its description", () => {
      // TODO(danfuzz): These pin the pairing by order as it stands, not as it
      // should be. Each later cell of the description is paired with a
      // neighbor's number, so the moves returned are not the cells' own.
      // Invert each to the moves the cells make once how two builds' cells are
      // to be matched is settled; `renumberedCells()` carries the matching
      // `TODO`.

      it("returns a later cell of the description under a neighbor's number, where a cell of another description sits between", () => {
        // Function cells `a` and `b` sit around a child, and a function cell
        // is added ahead of them: `a` moves 0 to 1, the child 1 to 2, and `b`
        // 2 to 3.
        expect(
          renumberedCells(
            cells([{ lift: true }, { child: CHILD }, { lift: true }]),
            cells([{ lift: true }, { lift: true }, { child: CHILD }, {
              lift: true,
            }]),
          ).map(({ description, from, to }) => [description, from, to]),
        ).toEqual([
          ["cell, computed, written by function", 2, 1],
          ["cell, computed, written by sub-pattern child-identi#Child", 1, 2],
        ]);
      });

      it("returns a later cell of the description under a neighbor's number when one ahead of it is removed", () => {
        // Function cells `a`, `b` and `c` sit around a child after `b`, and
        // `a` is removed: `b` moves 1 to 0, the child 2 to 1, and `c` 3 to 2.
        expect(
          renumberedCells(
            cells([{ lift: true }, { lift: true }, { child: CHILD }, {
              lift: true,
            }]),
            cells([{ lift: true }, { child: CHILD }, { lift: true }]),
          ).map(({ description, from, to }) => [description, from, to]),
        ).toEqual([
          ["cell, computed, written by sub-pattern child-identi#Child", 2, 1],
          ["cell, computed, written by function", 1, 2],
        ]);
      });
    });
  });
});
