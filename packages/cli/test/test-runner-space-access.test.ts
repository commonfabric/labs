import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/space-access");

describe(
  "test-runner",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    describe("`spaceAccess()` in the test's space", () => {
      it("returns `OWNER` to a single-user test, in a computed and a handler", async () => {
        const { passed, failed } = await runTests(
          resolve(FIXTURES, "single-user.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(0);
        expect(passed).toBe(2);
      });

      it("returns each multi-user participant its user's level, in a computed and a handler", async () => {
        const { passed, failed } = await runTests(
          resolve(FIXTURES, "multi-user.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(0);
        expect(passed).toBe(12);
      });
    });
  },
);
