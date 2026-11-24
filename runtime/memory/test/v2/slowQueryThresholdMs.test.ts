import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { slowQueryThresholdMs } from "../../v2/server.ts";

/** A reader that holds `value` for the one variable the threshold reads. */
const reading = (value: string | undefined) => (name: string) =>
  name === "CF_SLOW_QUERY_THRESHOLD_MS" ? value : "999";

describe("slowQueryThresholdMs()", () => {
  it("returns the variable's value when it is a non-negative number", () => {
    expect(slowQueryThresholdMs(reading("0"))).toBe(0);
    expect(slowQueryThresholdMs(reading("250"))).toBe(250);
    expect(slowQueryThresholdMs(reading("1.5"))).toBe(1.5);
  });

  it("returns `100` when the variable is unset, empty, negative, or not a finite number", () => {
    for (const value of [undefined, "", "-1", "fast", "Infinity"]) {
      expect(slowQueryThresholdMs(reading(value))).toBe(100);
    }
  });

  it("returns `100` when the variable cannot be read", () => {
    expect(slowQueryThresholdMs(() => {
      throw new Deno.errors.NotCapable("env access denied");
    })).toBe(100);
  });
});
