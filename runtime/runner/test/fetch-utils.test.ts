/**
 * What `computeInputHashFromValue()` deliberately ignores, which is most of
 * its contract: two inputs that differ only in ways carrying no request
 * content must hash the same.
 *
 * Three kinds of difference are erased -- the top-level `result` field, which
 * is a type hint rather than part of the request; a property that is present
 * but `undefined` against one simply omitted, at the top level and nested;
 * and an absent input against an empty object. The remaining case is the
 * counterweight, since erasing differences is only safe if a difference in
 * real content still changes the hash.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { computeInputHashFromValue } from "../src/builtins/fetch-utils.ts";

describe("computeInputHashFromValue", () => {
  it("drops the top-level `result` type-hint field", () => {
    const a = computeInputHashFromValue({ url: "x", mode: "json" });
    const b = computeInputHashFromValue({
      url: "x",
      mode: "json",
      result: "ignored type hint",
    });
    expect(a).toBe(b);
  });

  it("treats omitted vs `undefined` top-level properties identically", () => {
    const a = computeInputHashFromValue({ url: "x", mode: "json" });
    const b = computeInputHashFromValue({
      url: "x",
      mode: "json",
      options: undefined,
    });
    expect(a).toBe(b);
  });

  it("treats omitted vs `undefined` nested properties identically", () => {
    const a = computeInputHashFromValue({
      url: "x",
      options: { method: "GET" },
    });
    const b = computeInputHashFromValue({
      url: "x",
      options: { method: "GET", body: undefined },
    });
    expect(a).toBe(b);
  });

  it("distinguishes inputs that differ in non-`undefined` content", () => {
    const a = computeInputHashFromValue({ url: "x", mode: "json" });
    const b = computeInputHashFromValue({ url: "y", mode: "json" });
    expect(a).not.toBe(b);
  });

  it("treats `undefined` inputs as the empty object", () => {
    const a = computeInputHashFromValue(undefined);
    const b = computeInputHashFromValue({});
    expect(a).toBe(b);
  });
});
