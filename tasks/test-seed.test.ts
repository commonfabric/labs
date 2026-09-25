import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { main, requestedSeed } from "./test-seed.ts";

/** Runs `body` with the seed variable as `value`, restoring it after. */
function withSeedVariable(value: string, body: () => void): void {
  const previous = Deno.env.get("CF_TEST_SHUFFLE_SEED");
  Deno.env.set("CF_TEST_SHUFFLE_SEED", value);
  try {
    body();
  } finally {
    if (previous === undefined) Deno.env.delete("CF_TEST_SHUFFLE_SEED");
    else Deno.env.set("CF_TEST_SHUFFLE_SEED", previous);
  }
}

describe("test-seed", () => {
  it("gives the seed the environment names when given no argument", () => {
    withSeedVariable("12345", () => {
      expect(requestedSeed([], new Date("2026-09-23T11:00:00Z"))).toBe(12345);
    });
  });

  it("gives the next Pacific day's seed when given --tomorrow", () => {
    // 11:00 UTC on the 23rd is early on the 23rd in the Pacific zone, and
    // the seed the environment names is for the runs of this day.
    withSeedVariable("12345", () => {
      expect(requestedSeed(["--tomorrow"], new Date("2026-09-23T11:00:00Z")))
        .toBe(20260924);
    });
  });

  it("throws for an argument it does not know", () => {
    for (const args of [["--today"], ["--tomorrow", "--tomorrow"], ["1"]]) {
      expect(() => requestedSeed(args, new Date("2026-09-23T11:00:00Z")))
        .toThrow("test-seed takes no argument, or --tomorrow");
    }
  });

  describe("main()", () => {
    // A task hands the seed on through a command substitution, which
    // reads standard output whole, so the seed has to be alone there.

    it("prints the seed alone, names it separately, and returns 0", () => {
      const printed: string[] = [];
      const announced: string[] = [];
      expect(main(
        ["--tomorrow"],
        new Date("2026-09-23T11:00:00Z"),
        (line) => printed.push(line),
        (line) => announced.push(line),
      )).toBe(0);
      expect(printed).toEqual(["20260924"]);
      expect(announced).toEqual([
        "Test order shuffled with seed 20260924. " +
        "Set CF_TEST_SHUFFLE_SEED=20260924 to run this order again.",
      ]);
    });

    it("prints nothing, says why, and returns 2 for an argument it does not know", () => {
      const printed: string[] = [];
      const announced: string[] = [];
      expect(main(
        ["--today"],
        new Date("2026-09-23T11:00:00Z"),
        (line) => printed.push(line),
        (line) => announced.push(line),
      )).toBe(2);
      expect(printed).toEqual([]);
      expect(announced).toEqual([
        "test-seed takes no argument, or --tomorrow; it was given: --today",
      ]);
    });
  });
});
