import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { deepFreeze, hashStringOf } from "@";
import { getFrozenObjectHashCacheHitsForTestingOnly } from "@/for-testing-only.ts";

describe("getFrozenObjectHashCacheHits()", () => {
  it("counts only immutable object hashes served from cache", () => {
    const frozen = deepFreeze({ value: [1, 2, 3] });
    const mutable = { value: [1, 2, 3] };
    const before = getFrozenObjectHashCacheHitsForTestingOnly();
    hashStringOf(frozen);
    hashStringOf(mutable);
    hashStringOf(mutable);
    expect(getFrozenObjectHashCacheHitsForTestingOnly()).toBe(before);
    hashStringOf(frozen);
    expect(getFrozenObjectHashCacheHitsForTestingOnly()).toBe(before + 1);
  });
});
