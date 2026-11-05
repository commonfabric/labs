/**
 * Integration-level guard for console error/warning capture semantics.
 *
 * console.error() and console.warn() calls (plus logger-level activity) emitted
 * during a test run must fail the test unless the pattern opts out via
 * `allowConsoleErrors: true` or `allowConsoleWarnings: true`.
 *
 * Mirrors the design of test-runner-expect-non-idempotent.test.ts.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(
  import.meta.dirname!,
  "fixtures/console-capture",
);

function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

describe(
  "console capture semantics",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("fails when console.error is called and no allowConsoleErrors flag", async () => {
      const { passed, failed, results } = await runTests(
        fixture("console-error-unallowed.test.tsx"),
        { root: FIXTURES },
      );
      // The pattern's own assertion passes; the console error must add a failure.
      expect(passed).toBe(1);
      expect(failed).toBe(1);
      // Confirm the failure is reported as a console error, not a test assertion.
      const allErrors = results.flatMap((r) => r.consoleErrors ?? []);
      expect(allErrors.some((e) => e.includes("console.error"))).toBe(true);
    });

    it("passes when console.error is called and allowConsoleErrors is true", async () => {
      const { passed, failed } = await runTests(
        fixture("console-error-allowed.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(1);
      expect(failed).toBe(0);
    });

    it("fails when console.warn is called and no allowConsoleWarnings flag", async () => {
      const { passed, failed, results } = await runTests(
        fixture("console-warn-unallowed.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(1);
      expect(failed).toBe(1);
      const allWarnings = results.flatMap((r) => r.consoleWarnings ?? []);
      expect(allWarnings.some((w) => w.includes("console.warn"))).toBe(true);
    });

    it("passes when console.warn is called and allowConsoleWarnings is true", async () => {
      const { passed, failed } = await runTests(
        fixture("console-warn-allowed.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(1);
      expect(failed).toBe(0);
    });

    it("allowConsoleErrors and allowConsoleWarnings are independent", async () => {
      // allowConsoleErrors does NOT suppress warnings — they must be opted out
      // separately with allowConsoleWarnings.
      const { failed, results } = await runTests(
        fixture("console-error-allowed.test.tsx"),
        { root: FIXTURES },
      );
      // No warnings were emitted in the error-allowed fixture, so no warning failures.
      expect(failed).toBe(0);
      const allWarnings = results.flatMap((r) => r.consoleWarnings ?? []);
      expect(allWarnings.length).toBe(0);
    });
  },
);
