import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  assertValidUnavailableInputPolicy,
} from "../src/unavailable-input-policy.ts";

describe("unavailable input policy validation", () => {
  it("accepts exact paths with known, duplicate-free reasons", () => {
    const policy = [
      { path: [], reasons: ["pending"] },
      {
        path: ["nested", "0"],
        reasons: ["error", "syncing", "schemaMismatch"],
      },
    ];

    expect(() => assertValidUnavailableInputPolicy(policy)).not.toThrow();
  });

  it("fails closed for malformed policy structure", () => {
    for (
      const malformed of [
        null,
        {},
        [null],
        [{ path: "value", reasons: ["error"] }],
        [{ path: [0], reasons: ["error"] }],
        [{ path: ["value"], reasons: "error" }],
        [{ path: ["value"], reasons: [] }],
        [{ path: ["value"], reasons: ["offline"] }],
      ]
    ) {
      expect(() => assertValidUnavailableInputPolicy(malformed)).toThrow(
        /Invalid unavailable input policy/,
      );
    }
  });

  it("fails closed for duplicate reasons and duplicate exact paths", () => {
    expect(() =>
      assertValidUnavailableInputPolicy([
        { path: ["value"], reasons: ["error", "error"] },
      ])
    ).toThrow(/duplicate reason/);

    expect(() =>
      assertValidUnavailableInputPolicy([
        { path: ["value"], reasons: ["error"] },
        { path: ["value"], reasons: ["pending"] },
      ])
    ).toThrow(/duplicate exact path/);
  });

  it("rejects holes at every position in an exact path", () => {
    for (const hole of [0, 1, 2]) {
      const path = ["root", "branch", "leaf"];
      delete path[hole];

      expect(() =>
        assertValidUnavailableInputPolicy([{ path, reasons: ["error"] }])
      ).toThrow(/path must be an array of strings/);
    }
  });
});
