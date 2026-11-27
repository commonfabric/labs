// Run by `../registration.test.ts` as a test file of its own.

import { describe, it, test, wrapSuites } from "../../src/testing.ts";

const log = (what: string) => console.log(`LOG ${what}`);

wrapSuites(async (run) => {
  log("outer wrapper enters");
  await run();
  log("outer wrapper leaves");
});
wrapSuites(async (run) => {
  log("inner wrapper enters");
  await run();
  log("inner wrapper leaves");
});

describe("wrapped", () => {
  it("first", () => log("first"));
  it("second", () => log("second"));
});

test("alone", () => log("alone"));
