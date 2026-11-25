// Run by `../registration.test.ts` as a test file of its own. A refusal is
// caught and logged, so the file goes on to end as any other does.

import { describe, test } from "../../src/testing.ts";

describe("holder", () => {
  try {
    test("inside", () => {});
  } catch (error) {
    console.log(`LOG refused: ${(error as Error).message}`);
  }
});
