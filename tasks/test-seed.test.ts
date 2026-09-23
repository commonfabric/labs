import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { requestedSeed } from "./test-seed.ts";

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
});
