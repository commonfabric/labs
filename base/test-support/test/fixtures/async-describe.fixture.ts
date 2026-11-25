// Run by `../registration.test.ts` as a test file of its own. A refusal is
// caught and logged, so the file goes on to end as any other does.

import { describe, it } from "../../src/testing.ts";

try {
  describe("waits", async () => {
    await Promise.resolve();
    it("never registers", () => {});
  });
} catch (error) {
  console.log(`LOG refused: ${(error as Error).message}`);
}
