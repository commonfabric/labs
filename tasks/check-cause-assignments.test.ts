import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  acceptedMoveProblems,
  compareDumps,
  describeCompileErrors,
  describeFailures,
} from "./check-cause-assignments.ts";
import {
  assignmentDigest,
  type PatternAssignment,
} from "./cause-assignments-lib.ts";
import {
  ACCEPTED_MOVES,
  type AcceptedMove,
} from "./cause-assignments-accepted-moves.ts";

const CHILD = "cell, computed, written by sub-pattern child#Child";
const LIFT = "cell, computed, written by function";

/** One pattern's build, of one source, holding `cells` in number order. */
const build = (
  pattern: string,
  source: string,
  cells: readonly string[],
): PatternAssignment => ({
  pattern,
  source,
  levels: [{
    key: "",
    cells: cells.map((description, number) => ({
      number,
      description,
      holdsState: description === CHILD,
    })),
  }],
});

const dump = (...assignments: PatternAssignment[]) => ({
  assignments,
  errors: [],
});

const NOTHING_UNEVALUABLE = {
  base: new Set<string>(),
  head: new Set<string>(),
};

const NUMBERED = build("room.tsx", "s", [LIFT, CHILD]);
const RENUMBERED = build("room.tsx", "s", [CHILD]);

describe("check-cause-assignments", () => {
  describe("compareDumps()", () => {
    it("returns a failure for a pattern whose child moves under the same source", () => {
      const comparison = compareDumps(
        dump(NUMBERED),
        dump(RENUMBERED),
        [],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison.compared).toBe(1);
      expect(
        comparison.failing.map(({ pattern, moved }) => ({
          pattern,
          moved: moved.map((
            { from, to, holdsState },
          ) => [from, to, holdsState]),
        })),
      ).toEqual([{ pattern: "room.tsx", moved: [[1, 0, true]] }]);
    });

    it("returns no failure for a pattern numbered alike on both sides", () => {
      const comparison = compareDumps(
        dump(NUMBERED),
        dump(build("room.tsx", "s", [LIFT, CHILD])),
        [],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison).toEqual({
        failing: [],
        forgiven: [],
        unused: [],
        compared: 1,
        compileErrors: [],
      });
    });

    it("returns no comparison of a pattern whose source differs between the two sides", () => {
      const comparison = compareDumps(
        dump(NUMBERED),
        dump(build("room.tsx", "edited", [CHILD])),
        [],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison.compared).toBe(0);
      expect(comparison.failing).toEqual([]);
    });

    it("returns as forgiven a move an accepted entry names by both builds' digests", () => {
      const entry: AcceptedMove = {
        pattern: "room.tsx",
        base: assignmentDigest(NUMBERED),
        head: assignmentDigest(RENUMBERED),
        reason: "test",
      };

      const comparison = compareDumps(
        dump(NUMBERED),
        dump(RENUMBERED),
        [entry],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison.failing).toEqual([]);
      expect(comparison.forgiven).toEqual(["room.tsx"]);
      expect(comparison.unused).toEqual([]);
    });

    it("returns as a failure a move an accepted entry names by another build, and the entry as unused", () => {
      const entry: AcceptedMove = {
        pattern: "room.tsx",
        base: assignmentDigest(NUMBERED),
        head: assignmentDigest(build("room.tsx", "s", [CHILD, LIFT])),
        reason: "test",
      };

      const comparison = compareDumps(
        dump(NUMBERED),
        dump(RENUMBERED),
        [entry],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison.failing.map(({ pattern }) => pattern)).toEqual([
        "room.tsx",
      ]);
      expect(comparison.unused).toEqual([entry]);
    });

    it("returns each pattern either side failed to compile", () => {
      const comparison = compareDumps(
        {
          assignments: [],
          errors: [{ pattern: "a.tsx", error: "base broke" }],
        },
        {
          assignments: [NUMBERED],
          errors: [{ pattern: "b.tsx", error: "head broke" }],
        },
        [],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison.compileErrors).toEqual([
        { side: "base", pattern: "a.tsx", error: "base broke" },
        { side: "head", pattern: "b.tsx", error: "head broke" },
      ]);
      expect(describeCompileErrors(comparison)).toContain(
        "b.tsx (head build): head broke",
      );
    });

    it("returns no compile error for a pattern its side lists as unevaluable", () => {
      const comparison = compareDumps(
        dump(),
        {
          assignments: [],
          errors: [{ pattern: "listed.tsx", error: "never evaluates" }],
        },
        [],
        { base: new Set(), head: new Set(["listed.tsx"]) },
      );

      expect(comparison.compileErrors).toEqual([]);
    });

    it("returns no compile error for a base failure the base lists, where the change makes the pattern evaluate and takes it off the list", () => {
      const comparison = compareDumps(
        {
          assignments: [],
          errors: [{ pattern: "room.tsx", error: "never evaluates" }],
        },
        dump(NUMBERED),
        [],
        { base: new Set(["room.tsx"]), head: new Set() },
      );

      expect(comparison.compileErrors).toEqual([]);
    });

    it("returns a compile error for a head failure that only the base lists", () => {
      const comparison = compareDumps(
        dump(NUMBERED),
        {
          assignments: [],
          errors: [{ pattern: "room.tsx", error: "broke" }],
        },
        [],
        { base: new Set(["room.tsx"]), head: new Set() },
      );

      expect(comparison.compileErrors).toEqual([
        { side: "head", pattern: "room.tsx", error: "broke" },
      ]);
    });
  });

  describe("acceptedMoveProblems()", () => {
    const entry = (overrides: Partial<AcceptedMove> = {}): AcceptedMove => ({
      pattern: "room.tsx",
      base: assignmentDigest(NUMBERED),
      head: assignmentDigest(RENUMBERED),
      reason: "the transformer reads `row[UI]` in place",
      ...overrides,
    });

    it("returns nothing for an entry with a reason and two digests", () => {
      expect(acceptedMoveProblems([entry()])).toEqual([]);
    });

    it("returns a problem for an entry whose reason is blank", () => {
      expect(acceptedMoveProblems([entry({ reason: "  " })])).toEqual([
        `room.tsx (${assignmentDigest(NUMBERED)} -> ${
          assignmentDigest(RENUMBERED)
        }) gives no reason`,
      ]);
    });

    it("returns a problem for a digest not spelled as the gate prints one", () => {
      expect(acceptedMoveProblems([entry({ head: "abc" })]).length).toBe(1);
    });

    it("returns a problem for a pattern and pair of builds named twice", () => {
      expect(acceptedMoveProblems([entry(), entry()]).length).toBe(1);
    });

    it("returns nothing for the moves the repository accepts", () => {
      expect(acceptedMoveProblems(ACCEPTED_MOVES)).toEqual([]);
    });
  });

  describe("describeFailures()", () => {
    it("returns each moved cell with its two numbers, whether it holds state, and both builds' digests", () => {
      const comparison = compareDumps(
        dump(NUMBERED),
        dump(RENUMBERED),
        [],
        NOTHING_UNEVALUABLE,
      );
      const text = describeFailures(comparison);

      expect(text).toContain(
        `room.tsx (base build ${
          assignmentDigest(
            NUMBERED,
          )
        }, this build ${assignmentDigest(RENUMBERED)}):`,
      );
      expect(text).toContain(`  1 -> 0, holds state: ${CHILD} (entry pattern)`);
    });
  });
});
