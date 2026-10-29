import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { deepFreeze, hashStringOf } from "@";
import { getContainersHashedForTestingOnly } from "@/for-testing-only.ts";

describe("getContainersHashed()", () => {
  it("counts each array and plain object a hash feeds, and none a cached hash serves", () => {
    const value = deepFreeze({ list: [1, { name: "a" }], other: {} });
    const before = getContainersHashedForTestingOnly();
    hashStringOf(value);
    expect(getContainersHashedForTestingOnly()).toBe(before + 4);
    hashStringOf(value);
    expect(getContainersHashedForTestingOnly()).toBe(before + 4);
    hashStringOf("a string");
    expect(getContainersHashedForTestingOnly()).toBe(before + 4);
  });
});
