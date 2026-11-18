import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  BranchListWalk,
  REACHED_AGAIN,
} from "../../src/cfc/branch-list-walk.ts";

describe("BranchListWalk", () => {
  describe("instance members", () => {
    describe("expand()", () => {
      it("returns a settled result again only for a key equal in every element", () => {
        const list = {};
        const walk = new BranchListWalk<string>();
        let expansions = 0;
        const expandAs = (value: string) => () => {
          expansions++;
          return value;
        };

        expect(walk.expand([list, "a"], expandAs("short"))).toBe("short");
        expect(walk.expand([list, "a", "b"], expandAs("long"))).toBe("long");
        expect(walk.expand([list, "c"], expandAs("other"))).toBe("other");
        expect(expansions).toBe(3);

        expect(walk.expand([list, "a"], expandAs("unused"))).toBe("short");
        expect(walk.expand([list, "a", "b"], expandAs("unused"))).toBe("long");
        expect(expansions).toBe(3);
      });

      it("returns `REACHED_AGAIN` for a list reached while it is being expanded", () => {
        const list = {};
        const walk = new BranchListWalk<unknown>();
        const inner: unknown[] = [];
        walk.expand([list], () => {
          inner.push(walk.expand([list], () => "unused"));
          inner.push(walk.expand([list, "deeper"], () => "deeper"));
          return "outer";
        });
        expect(inner).toEqual([REACHED_AGAIN, "deeper"]);
      });
    });
  });
});
