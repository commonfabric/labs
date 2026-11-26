import { expect } from "@std/expect";

import { deepFreeze, hashStringOf } from "@";
import { getFrozenObjectHashCacheHitsForTestingOnly } from "@/for-testing-only.ts";
import { describe, it } from "@commonfabric/test-support/test";

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
