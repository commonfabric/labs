/**
 * Integration-level guard for expectRuntimeErrors semantics: the flag REQUIRES
 * runtime errors (exact count when numeric, and each named message when a
 * list) rather than merely tolerating them, so a thrown rejection quietly
 * reverting to a silent return, or giving another error, fails the suite that
 * depends on it.
 *
 * Mirrors the design of test-runner-console-capture.test.ts.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(
  import.meta.dirname!,
  "fixtures/expect-runtime-errors",
);

function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

describe(
  "expectRuntimeErrors semantics",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("passes when the expected error fires, and tolerates it", async () => {
      const { passed, failed } = await runTests(
        fixture("expected-and-throwing.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(1);
      expect(failed).toBe(0);
    });

    it("fails when errors were expected but none fired", async () => {
      const { passed, failed } = await runTests(
        fixture("expected-but-silent.test.tsx"),
        { root: FIXTURES },
      );
      // The pattern's own assertion passes; the unmet expectation must fail.
      expect(passed).toBe(1);
      expect(failed).toBe(1);
    });

    it("fails on an exact-count mismatch", async () => {
      const { passed, failed } = await runTests(
        fixture("expected-count-mismatch.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(1);
      expect(failed).toBe(1);
    });

    it("passes when each listed message is one fired error's, in any order", async () => {
      const { passed, failed } = await runTests(
        fixture("expected-messages.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(1);
      expect(failed).toBe(0);
    });

    it("fails when a fired error is not the one a listed message names", async () => {
      const { passed, failed } = await runTests(
        fixture("expected-messages-mismatch.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(1);
      expect(failed).toBe(1);
    });

    it("fails a run whose expectation is malformed, naming the value", async () => {
      const { passed, failed, results } = await runTests(
        fixture("expected-malformed.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(0);
      expect(failed).toBe(1);
      expect(results[0].error).toContain(
        "`expectRuntimeErrors` is `true`, a positive whole count, or a non-empty list of strings, not",
      );
      expect(results[0].error).toContain("1.5");
    });
  },
);
