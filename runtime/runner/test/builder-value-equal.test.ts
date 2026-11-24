/**
 * `valueEqual` is exposed to pattern code through the `commonfabric` builder
 * surface (declared in `api/index.ts`, bound in `builder/factory.ts`). These
 * tests pin that it is present and is the real `data-model` `valueEqual` — the
 * `Object.is`-leading, content-hash comparison — rather than a stand-in.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createBuilder } from "../src/builder/factory.ts";

describe("commonfabric valueEqual builtin", () => {
  const { valueEqual } = createBuilder().commonfabric;

  it("is exposed as a function on the pattern surface", () => {
    expect(typeof valueEqual).toBe("function");
  });

  it("compares primitives with Object.is semantics", () => {
    expect(valueEqual(NaN, NaN)).toBe(true);
    expect(valueEqual(-0, 0)).toBe(false);
    expect(valueEqual(1, 1)).toBe(true);
    expect(valueEqual(1, "1")).toBe(false);
  });

  it("compares objects by content, independent of key order", () => {
    expect(valueEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(valueEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(valueEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(valueEqual([1, 2], [1, 2, 3])).toBe(false);
  });
});
