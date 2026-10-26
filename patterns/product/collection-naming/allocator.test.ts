/**
 * The allocation rule, run directly rather than through a pattern runtime.
 * Importing `allocator.ts` from a plain `deno test` is half of what this file
 * checks: `commonfabric` declares `lift`, `equals` and `Writable` with
 * `export declare const`, which binds nothing at runtime, so a module that
 * takes one of them as a value fails to link here. A named import of the
 * allocator that stops linking is this suite failing, whatever the cases
 * below say.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  assignName,
  createNamed,
  incrementName,
  isLargerName,
  isMemberName,
  type NamesMap,
  type NamesMapCell,
  nextNameAmong,
} from "./allocator.ts";

/**
 * A stand-in for the namespace cell a verb holds: `get()` reads the map back
 * and `key(name).set(member)` writes one entry, both over an ordinary object.
 * `entries` is left out for a collection that has never named a member, whose
 * map reads `undefined` inside a verb.
 */
function namesMapCell(entries?: NamesMap): NamesMapCell {
  let map = entries;
  return {
    get: () => map,
    key: (name: string) => ({
      set: (member: unknown) => {
        map = { ...map, [name]: member };
      },
    }),
  };
}

describe("allocator", () => {
  describe("isMemberName()", () => {
    it("returns `true` for `0` and for a decimal with no leading zero", () => {
      expect(isMemberName("0")).toBe(true);
      expect(isMemberName("1")).toBe(true);
      expect(isMemberName("42")).toBe(true);
      expect(isMemberName("9007199254740993")).toBe(true);
    });

    it("returns `false` for a decimal with a leading zero", () => {
      expect(isMemberName("07")).toBe(false);
      expect(isMemberName("00")).toBe(false);
    });

    it("returns `false` for a signed, spaced, exponent or hexadecimal spelling of a number", () => {
      expect(isMemberName("+5")).toBe(false);
      expect(isMemberName("-1")).toBe(false);
      expect(isMemberName(" 6")).toBe(false);
      expect(isMemberName("6 ")).toBe(false);
      expect(isMemberName("1e3")).toBe(false);
      expect(isMemberName("0x10")).toBe(false);
      expect(isMemberName("1.0")).toBe(false);
    });

    it("returns `false` for the empty string and for a key holding no digits", () => {
      expect(isMemberName("")).toBe(false);
      expect(isMemberName("alpha")).toBe(false);
    });
  });

  describe("isLargerName()", () => {
    it("returns `true` for the longer of two names, whichever digits they open with", () => {
      expect(isLargerName("10", "9")).toBe(true);
      expect(isLargerName("9", "10")).toBe(false);
      expect(isLargerName("1000", "999")).toBe(true);
    });

    it("returns `true` for the later of two names of the same length", () => {
      expect(isLargerName("13", "12")).toBe(true);
      expect(isLargerName("12", "13")).toBe(false);
    });

    it("returns `false` for a name compared against itself", () => {
      expect(isLargerName("42", "42")).toBe(false);
    });
  });

  describe("incrementName()", () => {
    it("returns the next decimal for a name whose last digit is not a nine", () => {
      expect(incrementName("0")).toBe("1");
      expect(incrementName("1")).toBe("2");
      expect(incrementName("41")).toBe("42");
    });

    it("carries a trailing run of nines to zeros and raises the digit before it", () => {
      expect(incrementName("19")).toBe("20");
      expect(incrementName("1299")).toBe("1300");
      expect(incrementName("10999")).toBe("11000");
    });

    it("returns a name one digit longer for a name that is all nines", () => {
      expect(incrementName("9")).toBe("10");
      expect(incrementName("99")).toBe("100");
      expect(incrementName("999999")).toBe("1000000");
    });
  });

  describe("nextNameAmong()", () => {
    it("returns `1` over no keys at all", () => {
      expect(nextNameAmong([])).toBe("1");
    });

    it("returns one more than the largest name present", () => {
      expect(nextNameAmong(["1", "2"])).toBe("3");
      expect(nextNameAmong(["3", "5"])).toBe("6");
      expect(nextNameAmong(["99"])).toBe("100");
    });

    it("returns one more than the longest name rather than the lexicographically last", () => {
      // `"9" > "10"` as strings, so a plain string comparison would hand back
      // `10` for a map that already holds it.
      expect(nextNameAmong(["2", "10"])).toBe("11");
      expect(nextNameAmong(["9", "10"])).toBe("11");
    });

    it("returns a distinct name past `2^53`, where a number comparison would reuse one", () => {
      // The witness: incrementing through a number stops moving here, so a
      // name that round-tripped through one would be handed out twice.
      expect(Number("9007199254740992") + 1).toBe(9007199254740992);

      expect(nextNameAmong(["9007199254740992"])).toBe("9007199254740993");
      expect(nextNameAmong(["9007199254740992", "9007199254740993"])).toBe(
        "9007199254740994",
      );
      expect(nextNameAmong(["999999999999999999999999"])).toBe(
        "1000000000000000000000000",
      );
    });

    it("ignores a key outside the name grammar", () => {
      expect(nextNameAmong(["007", "1e3", "abc", "4"])).toBe("5");
      // A foreign key that would be the largest were it a name leaves the
      // sequence where the names put it.
      expect(nextNameAmong(["4", "99999999999999999999x"])).toBe("5");
    });

    it("returns `1` when no key is a member name", () => {
      expect(nextNameAmong(["007", "1e3", "abc"])).toBe("1");
      expect(nextNameAmong(["+5", "-1", " 6", "6 ", "0x10"])).toBe("1");
    });
  });

  describe("createNamed()", () => {
    it("calls `create` with the name it records the member under", () => {
      const names = namesMapCell({ "1": { title: "first" } });
      const handed: string[] = [];

      const { name, member } = createNamed(names, (allocated) => {
        handed.push(allocated);
        return { title: `item ${allocated}` };
      });

      expect(handed).toEqual(["2"]);
      expect(name).toBe("2");
      expect(member).toEqual({ title: "item 2" });
      expect(names.get()?.["2"]).toBe(member);
    });

    it("allocates over an absent map as though it held no names", () => {
      const names = namesMapCell();

      const { name } = createNamed(names, () => ({ title: "only" }));

      expect(name).toBe("1");
      expect(names.get()).toEqual({ "1": { title: "only" } });
    });

    it("takes consecutive names across successive calls on one map", () => {
      const names = namesMapCell();

      const first = createNamed(names, (allocated) => allocated);
      const second = createNamed(names, (allocated) => allocated);
      const third = createNamed(names, (allocated) => allocated);

      expect([first.name, second.name, third.name]).toEqual(["1", "2", "3"]);
      expect(names.get()).toEqual({ "1": "1", "2": "2", "3": "3" });
    });

    it("runs `create` exactly once", () => {
      const names = namesMapCell();
      let runs = 0;

      createNamed(names, () => {
        runs += 1;
        return {};
      });

      expect(runs).toBe(1);
    });

    it("allocates past the largest name a map holds, whatever else is in it", () => {
      const names = namesMapCell({ "1": {}, "10": {}, "9": {}, alpha: {} });

      expect(createNamed(names, () => ({})).name).toBe("11");
    });
  });

  describe("assignName()", () => {
    it("returns the name it records the member under", () => {
      const names = namesMapCell({ "1": {}, "2": {} });
      const member = { title: "already filed" };

      const name = assignName(names, member);

      expect(name).toBe("3");
      expect(names.get()?.["3"]).toBe(member);
    });

    it("names a member the map already holds under a second name", () => {
      // A name is never reused, and nothing here asks whether the member is
      // new: naming one twice takes two names.
      const member = { title: "twice" };
      const names = namesMapCell({ "1": member });

      expect(assignName(names, member)).toBe("2");
      expect(names.get()).toEqual({ "1": member, "2": member });
    });
  });
});
