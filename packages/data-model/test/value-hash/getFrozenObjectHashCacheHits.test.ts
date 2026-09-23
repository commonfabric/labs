import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { deepFreeze, getFrozenObjectHashCacheHits, hashStringOf } from "@";

describe("getFrozenObjectHashCacheHits()", () => {
  it("counts only immutable object hashes served from cache", () => {
    const frozen = deepFreeze({ value: [1, 2, 3] });
    const mutable = { value: [1, 2, 3] };
    const before = getFrozenObjectHashCacheHits();
    hashStringOf(frozen);
    hashStringOf(mutable);
    hashStringOf(mutable);
    expect(getFrozenObjectHashCacheHits()).toBe(before);
    hashStringOf(frozen);
    expect(getFrozenObjectHashCacheHits()).toBe(before + 1);
  });
});
