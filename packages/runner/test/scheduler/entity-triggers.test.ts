import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  assertNoTriggerDrift,
  EntityTriggers,
  resetTriggerScanWork,
  triggerEquivalenceEnabled,
  triggerScanWork,
} from "../../src/scheduler/entity-triggers.ts";
import { arraysOverlap } from "../../src/reactive-dependencies.ts";
import type { Action } from "../../src/scheduler/types.ts";

/** An action that does nothing, named so a failure says which one it was. */
function reader(name: string): Action {
  return ({ [name]: () => {} })[name]!;
}

/** What `matching()` returned, as plain data an expectation can name. */
function matched(
  triggers: EntityTriggers,
  writePath: readonly string[],
): Record<string, string[][]> {
  const result: Record<string, string[][]> = {};
  for (const [action, paths] of triggers.matching(writePath)) {
    result[action.name] = paths.map((path) => [...path]);
  }
  return result;
}

describe("EntityTriggers", () => {
  describe("instance members", () => {
    describe("matching()", () => {
      it("returns a read at the written path", () => {
        const triggers = new EntityTriggers();
        triggers.set(reader("exact"), [["value", "a"]]);
        expect(matched(triggers, ["value", "a"])).toEqual({
          exact: [["value", "a"]],
        });
      });

      it("returns a read above the written path", () => {
        const triggers = new EntityTriggers();
        triggers.set(reader("whole"), [[]]);
        triggers.set(reader("above"), [["value"]]);
        expect(matched(triggers, ["value", "a", "b"])).toEqual({
          whole: [[]],
          above: [["value"]],
        });
      });

      it("returns a read below the written path", () => {
        const triggers = new EntityTriggers();
        triggers.set(reader("below"), [["value", "a", "b"]]);
        expect(matched(triggers, ["value", "a"])).toEqual({
          below: [["value", "a", "b"]],
        });
      });

      it("omits a read on a sibling of the written path", () => {
        const triggers = new EntityTriggers();
        triggers.set(reader("sibling"), [["value", "b"]]);
        triggers.set(reader("cousin"), [["other", "a"]]);
        expect(matched(triggers, ["value", "a"])).toEqual({});
      });

      it("returns every read for a write at the document root", () => {
        const triggers = new EntityTriggers();
        triggers.set(reader("first"), [["value", "a"]]);
        triggers.set(reader("second"), [["other"]]);
        expect(matched(triggers, [])).toEqual({
          first: [["value", "a"]],
          second: [["other"]],
        });
      });

      it("returns an action's matching paths in ascending path order", () => {
        // Registered out of order, because ascending order is what
        // `determineTriggeredActions()` reads its groups in and registration
        // order would satisfy an already-ascending list either way.

        const triggers = new EntityTriggers();
        triggers.set(reader("several"), [
          ["value", "b", "y"],
          ["value", "a", "x"],
          ["value"],
          ["value", "b"],
        ]);
        expect(matched(triggers, ["value", "b"])).toEqual({
          several: [["value"], ["value", "b"], ["value", "b", "y"]],
        });
      });

      it("returns every action registered on one path", () => {
        const triggers = new EntityTriggers();
        triggers.set(reader("first"), [["value", "a"]]);
        triggers.set(reader("second"), [["value", "a"]]);
        expect(matched(triggers, ["value", "a"])).toEqual({
          first: [["value", "a"]],
          second: [["value", "a"]],
        });
      });

      it("agrees with the overlap predicate over a mixed registration", () => {
        // The index prunes what a write has to consider, and the predicate
        // decides. Drift between the two is a dropped trigger, so this walks
        // every registered path against every written path and compares.

        const paths = [
          [],
          ["value"],
          ["value", "a"],
          ["value", "a", "b"],
          ["value", "a", "c"],
          ["value", "ab"],
          ["value", "b"],
          ["other"],
        ];
        const triggers = new EntityTriggers();
        for (const path of paths) {
          triggers.set(reader(path.join("/")), [path]);
        }
        for (const writePath of paths) {
          const expected = paths
            .filter((path) => arraysOverlap(path, writePath))
            .map((path) => path.join("/"))
            .sort();
          expect(Object.keys(matched(triggers, writePath)).sort()).toEqual(
            expected,
          );
        }
      });

      it("visits a number of paths set by the written path, not by the readership", () => {
        const small = new EntityTriggers();
        const large = new EntityTriggers();
        for (let i = 0; i < 16; i++) {
          small.set(reader(`small-${i}`), [["value", `member-${i}`]]);
        }
        for (let i = 0; i < 1024; i++) {
          large.set(reader(`large-${i}`), [["value", `member-${i}`]]);
        }

        resetTriggerScanWork();
        small.matching(["value", "member-8"]);
        const smallVisits = triggerScanWork.pathsVisited;
        resetTriggerScanWork();
        large.matching(["value", "member-8"]);
        expect(triggerScanWork.pathsVisited).toBe(smallVisits);
      });
    });

    describe("set()", () => {
      it("replaces what the action read before", () => {
        const triggers = new EntityTriggers();
        const action = reader("moved");
        triggers.set(action, [["value", "a"]]);
        triggers.set(action, [["value", "b"]]);
        expect(matched(triggers, ["value", "a"])).toEqual({});
        expect(matched(triggers, ["value", "b"])).toEqual({
          moved: [["value", "b"]],
        });
      });

      it("counts one action however many times it registers", () => {
        const triggers = new EntityTriggers();
        const action = reader("repeat");
        triggers.set(action, [["value", "a"]]);
        triggers.set(action, [["value", "a"]]);
        expect(triggers.size).toBe(1);
      });
    });

    describe("delete()", () => {
      it("removes every path the action read", () => {
        const triggers = new EntityTriggers();
        const action = reader("gone");
        triggers.set(action, [["value", "a"], ["value", "b"]]);
        triggers.delete(action);
        expect(triggers.size).toBe(0);
        expect(matched(triggers, ["value", "a"])).toEqual({});
        expect(matched(triggers, ["value", "b"])).toEqual({});
      });

      it("leaves a path another action still reads", () => {
        const triggers = new EntityTriggers();
        const gone = reader("gone");
        const stays = reader("stays");
        triggers.set(gone, [["value", "a"]]);
        triggers.set(stays, [["value", "a"]]);
        triggers.delete(gone);
        expect(matched(triggers, ["value", "a"])).toEqual({
          stays: [["value", "a"]],
        });
      });

      it("visits no more of the index than an empty one once every action is gone", () => {
        const triggers = new EntityTriggers();
        const empty = new EntityTriggers();
        for (let i = 0; i < 64; i++) {
          const action = reader(`member-${i}`);
          triggers.set(action, [["value", `member-${i}`]]);
          triggers.delete(action);
        }

        resetTriggerScanWork();
        empty.matching(["value", "member-8"]);
        const emptyVisits = triggerScanWork.pathsVisited;
        resetTriggerScanWork();
        triggers.matching(["value", "member-8"]);
        expect(triggerScanWork.pathsVisited).toBe(emptyVisits);
      });

      it("leaves `size` unchanged for an action it does not hold", () => {
        const triggers = new EntityTriggers();
        triggers.set(reader("present"), [["value", "a"]]);
        triggers.delete(reader("absent"));
        expect(triggers.size).toBe(1);
      });
    });

    describe("size", () => {
      it("returns the number of actions registered", () => {
        const triggers = new EntityTriggers();
        expect(triggers.size).toBe(0);
        triggers.set(reader("first"), [["value", "a"]]);
        triggers.set(reader("second"), [["value", "b"]]);
        expect(triggers.size).toBe(2);
      });
    });
  });

  describe("registering the same reads again", () => {
    it("leaves the index untouched when handed back the same list", () => {
      const triggers = new EntityTriggers();
      const action = reader("same-list");
      const paths = [["value", "count"]];
      triggers.set(action, paths);
      triggers.set(action, paths);

      expect(matched(triggers, ["value", "count"])).toEqual({
        "same-list": [["value", "count"]],
      });
    });

    it("reports a read it cannot find rather than removing another", () => {
      // A list holding one path twice is not the compact form the type
      // promises. Taking it out walks to that path twice, and the second walk
      // arrives where the first pruned.
      const triggers = new EntityTriggers();
      const action = reader("repeated-path");
      triggers.set(action, [["value"], ["value"]]);

      expect(() => triggers.set(action, [["other"]])).toThrow(
        "Registered read `value` is missing from the index.",
      );
    });
  });

  describe("assertNoTriggerDrift()", () => {
    it("accepts an answer holding exactly the reads the write overlaps", () => {
      const registered = [["value", "a"], ["value", "b"], ["other"]];
      expect(() =>
        assertNoTriggerDrift([["value", "a"]], registered, ["value", "a"])
      ).not.toThrow();
    });

    it("names a read the answer left out", () => {
      const registered = [["value", "a"]];
      expect(() => assertNoTriggerDrift([], registered, ["value", "a"]))
        .toThrow('Trigger index drift for write ["value","a"]: ["value","a"]');
    });

    it("names a read the answer invented", () => {
      expect(() => assertNoTriggerDrift([["value", "a"]], [], ["value", "a"]))
        .toThrow('Trigger index drift for write ["value","a"]: ["value","a"]');
    });

    it("tells a component holding a separator from two components", () => {
      // `["a/b"]` and `["a", "b"]` are different reads, and a write to one
      // reaches neither the other nor anything below it.
      expect(() => assertNoTriggerDrift([["a/b"]], [["a", "b"]], ["a/b"]))
        .toThrow('Trigger index drift for write ["a/b"]: ["a/b"]');
    });
  });

  describe("triggerEquivalenceEnabled()", () => {
    it("runs the check under a test environment and nowhere else", () => {
      expect(triggerEquivalenceEnabled(() => "test")).toBe(true);
      expect(triggerEquivalenceEnabled(() => "production")).toBe(false);
      expect(triggerEquivalenceEnabled(() => undefined)).toBe(false);
    });

    it("stays off when the environment cannot be read", () => {
      expect(triggerEquivalenceEnabled(() => {
        throw new Deno.errors.NotCapable("requires env access");
      })).toBe(false);
    });
  });
});
