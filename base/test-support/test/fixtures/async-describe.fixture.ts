// Run by `../registration.test.ts` as a test file of its own.

import { describe, it } from "../../src/testing.ts";

describe("waits", async () => {
  await Promise.resolve();
  it("never registers", () => {});
});
