// Run by `../registration.test.ts` as a test file of its own.

import { describe, it, test } from "../../src/testing.ts";

describe("stuck", () => {
  it("waits forever", async () => {
    await new Promise(() => {});
  });
});

test("after", () => {});
