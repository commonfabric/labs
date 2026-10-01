import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(
  import.meta.dirname!,
  "fixtures/space-access-notices",
);

describe(
  "test-runner",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    describe("`noticeSpaceAccess()` in the test's runtime", () => {
      // A send the runtime's inbox did not answer is logged at error level,
      // which fails the file on top of its assertions, so a clean pass is
      // what shows the notice was delivered.

      it("delivers a single-user test's notice and reports it through the `spaceAccessNotices` input", async () => {
        const { passed, failed, results } = await runTests(
          resolve(FIXTURES, "single-user.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(0);
        expect(passed).toBe(6);
        expect(results[0].consoleErrors).toEqual([]);
        expect(results[0].runtimeErrors).toEqual([]);
      });

      it("reports each multi-user participant the notices its own runtime sent", async () => {
        const { passed, failed, results } = await runTests(
          resolve(FIXTURES, "multi-user.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(0);
        expect(passed).toBe(4);
        expect(results[0].consoleErrors).toEqual([]);
        expect(results[0].runtimeErrors).toEqual([]);
      });
    });
  },
);
