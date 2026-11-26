// Run by `../registration.test.ts` as a test file of its own. Each line
// starting `LOG ` says what ran.

import { afterAll, beforeAll, describe, it, test } from "../../src/testing.ts";

const log = (what: string) => console.log(`LOG ${what}`);

beforeAll(() => {
  throw new Error("the file's setup failed");
});
afterAll(() => log("file afterAll"));

describe("suite", () => {
  it("never runs", () => log("never runs"));
});

test("alone", () => log("alone"));
