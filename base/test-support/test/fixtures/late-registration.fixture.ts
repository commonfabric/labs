// Run by `../registration.test.ts` as a test file of its own.

import { describe, it, test } from "../../src/testing.ts";

describe("late", () => {
  it("registers another test while running", () => {
    it("too late", () => {});
  });
  it("declares a suite inside a describe", () => {});
});

test("nests", () => {
  describe("inner", () => {});
});
