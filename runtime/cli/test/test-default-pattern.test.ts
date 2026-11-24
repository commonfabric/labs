import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";

import { runTests } from "../lib/test-runner.ts";

describe("test-default-pattern", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  it("provides readable empty optional context rather than unresolved documents", async () => {
    const file = fromFileUrl(
      new URL("fixtures/default-context.test.tsx", import.meta.url),
    );
    const result = await runTests(file, {});
    expect(result.results.map((test) => test.error)).toEqual([undefined]);
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(2);
  });
});
