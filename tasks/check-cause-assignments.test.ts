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
const IF_ELSE = "cell, computed, written by builtin ifElse";

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
      hasState: description === CHILD,
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

// Three children of one pattern, and the first removed: the pairing by order
// reads the other two as unmoved.
const THREE_CHILDREN = build("lobby.tsx", "s", [CHILD, CHILD, CHILD]);
const TWO_CHILDREN = build("lobby.tsx", "s", [CHILD, CHILD]);

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
            { from, to, hasState },
          ) => [from, to, hasState]),
        })),
      ).toEqual([{ pattern: "room.tsx", moved: [[1, 0, true]] }]);
    });

    it("returns a failure for a pattern whose count of children of one pattern differs, where the pairing reports no move", () => {
      const comparison = compareDumps(
        dump(THREE_CHILDREN),
        dump(TWO_CHILDREN),
        [],
        NOTHING_UNEVALUABLE,
      );

      expect(
        comparison.failing.map(({ pattern, moved, ambiguous }) => ({
          pattern,
          moved,
          ambiguous: ambiguous.map(({ before, after }) => [before, after]),
        })),
      ).toEqual([{
        pattern: "lobby.tsx",
        moved: [],
        ambiguous: [[[0, 1, 2], [0, 1]]],
      }]);
    });

    it("returns no move for children of one pattern whose cells cannot be matched, only their numbers on each side", () => {
      const comparison = compareDumps(
        dump(build("lobby.tsx", "s", [LIFT, CHILD, CHILD])),
        dump(TWO_CHILDREN),
        [],
        NOTHING_UNEVALUABLE,
      );

      expect(
        comparison.failing.map(({ moved, ambiguous }) => ({
          moved,
          ambiguous: ambiguous.filter(({ hasState }) => hasState).map((
            { before, after },
          ) => [before, after]),
        })),
      ).toEqual([{ moved: [], ambiguous: [[[1, 2], [0, 1]]] }]);
    });

    it("returns as forgiven children of one pattern whose count differs, where an accepted entry names both builds' digests", () => {
      const comparison = compareDumps(
        dump(THREE_CHILDREN),
        dump(TWO_CHILDREN),
        [{
          pattern: "lobby.tsx",
          base: assignmentDigest(THREE_CHILDREN),
          head: assignmentDigest(TWO_CHILDREN),
          reason: "test",
        }],
        NOTHING_UNEVALUABLE,
      );

      expect(comparison.failing).toEqual([]);
      expect(comparison.forgiven).toEqual(["lobby.tsx"]);
    });

    describe("for cells holding no state", () => {
      it("returns a failure where the pairing reports a move, giving both builds' numbers for a description whose count differs in place of its moves", () => {
        // A lift is added ahead of a lift and an `ifElse`: the pairing reads
        // the later lift under its neighbor's number, and the `ifElse` as
        // moved 1 to 2.
        const comparison = compareDumps(
          dump(build("note.tsx", "s", [LIFT, IF_ELSE, LIFT])),
          dump(build("note.tsx", "s", [LIFT, LIFT, IF_ELSE, LIFT])),
          [],
          NOTHING_UNEVALUABLE,
        );

        expect(
          comparison.failing.map(({ moved, ambiguous }) => ({
            moved: moved.map(({ description, from, to }) => [
              description,
              from,
              to,
            ]),
            ambiguous: ambiguous.map((
              { description, before, after, hasState },
            ) => [description, before, after, hasState]),
          })),
        ).toEqual([{
          moved: [[IF_ELSE, 1, 2]],
          ambiguous: [[LIFT, [0, 2], [0, 1, 3], false]],
        }]);
      });

      it("returns a description whose count differs where the pattern fails for a move of another description", () => {
        const comparison = compareDumps(
          dump(build("note.tsx", "s", [LIFT, LIFT, LIFT, CHILD])),
          dump(build("note.tsx", "s", [LIFT, LIFT, CHILD])),
          [],
          NOTHING_UNEVALUABLE,
        );

        expect(
          comparison.failing.map(({ moved, ambiguous }) => ({
            moved: moved.map(({ from, to, hasState }) => [
              from,
              to,
              hasState,
            ]),
            ambiguous: ambiguous.map(({ before, after, hasState }) => [
              before,
              after,
              hasState,
            ]),
          })),
        ).toEqual([{
          moved: [[3, 2, true]],
          ambiguous: [[[0, 1, 2], [0, 1], false]],
        }]);
      });

      it("returns no failure for a description whose count differs where the pairing reports no move", () => {
        // TODO(danfuzz): This pins the gate as it stands, not as it should
        // be: the first of three lifts is removed and the other two move, but
        // the pairing by order reports no move and the gate passes. Invert it
        // to a failure once how cells holding no state are to be matched is
        // settled; `compareDumps()` carries the matching `TODO`.
        const comparison = compareDumps(
          dump(build("note.tsx", "s", [LIFT, LIFT, LIFT])),
          dump(build("note.tsx", "s", [LIFT, LIFT])),
          [],
          NOTHING_UNEVALUABLE,
        );

        expect(comparison.compared).toBe(1);
        expect(comparison.failing).toEqual([]);
      });
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
    it("returns a description only the base build has as removed, and one only this build has as added, with its numbers", () => {
      // A lift and a child are removed, and an `ifElse` is added: the child's
      // move fails the pattern, and each description one side lacks is named
      // with the numbers the other side gives it.
      const text = describeFailures(
        compareDumps(
          dump(build("note.tsx", "s", [LIFT, CHILD])),
          dump(build("note.tsx", "s", [IF_ELSE])),
          [],
          NOTHING_UNEVALUABLE,
        ),
      );

      expect(text).toContain(`  removed: [0]: ${LIFT} (entry pattern)`);
      expect(text).toContain(
        `  removed, holds state: [1]: ${CHILD} (entry pattern)`,
      );
      expect(text).toContain(`  added: [0]: ${IF_ELSE} (entry pattern)`);
      expect(text).not.toContain("ambiguous");
    });

    it("returns a description of cells holding no state that cannot be matched, with both builds' numbers and no mention of state", () => {
      const text = describeFailures(
        compareDumps(
          dump(build("note.tsx", "s", [LIFT, IF_ELSE, LIFT])),
          dump(build("note.tsx", "s", [LIFT, LIFT, IF_ELSE, LIFT])),
          [],
          NOTHING_UNEVALUABLE,
        ),
      );

      expect(text).toContain(
        `  ambiguous: [0, 2] -> [0, 1, 3]: ${LIFT} (entry pattern)`,
      );
      expect(text).toContain(`  1 -> 2: ${IF_ELSE} (entry pattern)`);
      expect(text).not.toContain(`2 -> 1: ${LIFT}`);
    });

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

    it("returns each description of cells holding state that cannot be matched, with both builds' numbers for it", () => {
      const text = describeFailures(
        compareDumps(
          dump(THREE_CHILDREN),
          dump(TWO_CHILDREN),
          [],
          NOTHING_UNEVALUABLE,
        ),
      );

      expect(text).toContain(
        `  ambiguous, holds state: [0, 1, 2] -> [0, 1]: ${CHILD} (entry pattern)`,
      );
    });
  });
});
