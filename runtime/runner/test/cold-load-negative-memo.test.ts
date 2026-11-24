import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { ColdLoadNegativeMemo } from "../src/cold-load-negative-memo.ts";

describe("ColdLoadNegativeMemo", () => {
  it("suppresses a failure only under the version that recorded it", () => {
    const memo = new ColdLoadNegativeMemo();
    memo.add("identity", "v1");

    expect(memo.suppresses("identity", "v1")).toBe(true);
    expect(memo.suppresses("identity", "v2")).toBe(false);
    expect(memo.suppresses("identity", "v1")).toBe(false);
  });

  it("rejects a non-positive or fractional capacity", () => {
    expect(() => new ColdLoadNegativeMemo(0)).toThrow(RangeError);
    expect(() => new ColdLoadNegativeMemo(1.5)).toThrow(RangeError);
  });

  it("evicts distinct identities in insertion order", () => {
    const memo = new ColdLoadNegativeMemo(2);
    memo.add("oldest", "v1");
    memo.add("middle", "v1");
    memo.add("newest", "v1");

    expect(memo.suppresses("oldest", "v1")).toBe(false);
    expect(memo.suppresses("middle", "v1")).toBe(true);
    expect(memo.suppresses("newest", "v1")).toBe(true);
  });
});
