// Run by `../registration.test.ts` as a test file of its own.

import { afterAll, beforeAll, test } from "../../src/testing.ts";

beforeAll(() => {});

afterAll(() => {
  throw new Error("the file's teardown failed");
});

test("one", () => {});
