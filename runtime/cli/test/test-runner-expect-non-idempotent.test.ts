/**
 * Integration-level guard for the `expectNonIdempotent` test-flag semantics.
 *
 * The flag is an ASSERTION that the idempotency detector fires, not a mere
 * tolerance: a flagged test must FAIL when zero violations are detected
 * (otherwise a detection regression silently defangs the fixtures in
 * patterns/dev/test/non-idempotent/), and must keep PASSING when
 * violations are present. Covers both the single-runtime path (runTests
 * reporting) and the multi-user orchestrator (per-participant aggregation,
 * where ANY flagged participant seeing a violation satisfies the
 * expectation).
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(
  import.meta.dirname!,
  "fixtures/expect-non-idempotent",
);

function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

describe(
  "expectNonIdempotent semantics",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("fails when flagged but no violation is detected", async () => {
      const { passed, failed } = await runTests(
        fixture("expected-but-idempotent.test.tsx"),
        { root: FIXTURES },
      );
      // The fixture's own assertion passes; the unmet expectation must add
      // exactly one failure.
      expect(passed).toBe(1);
      expect(failed).toBe(1);
    });

    it("passes when flagged and a violation is detected", async () => {
      const { passed, failed } = await runTests(
        fixture("expected-and-violating.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(1);
      expect(failed).toBe(0);
    });

    it("still fails on unexpected violations (no flag)", async () => {
      const { failed } = await runTests(
        fixture("unexpected-violation.test.tsx"),
        { root: FIXTURES },
      );
      expect(failed).toBeGreaterThan(0);
    });

    it("disables verification only when requested for a measurement", async () => {
      const { passed, failed } = await runTests(
        fixture("unexpected-violation.test.tsx"),
        { root: FIXTURES, noIdempotencyCheck: true },
      );
      expect(passed).toBe(1);
      expect(failed).toBe(0);
    });

    it("disables the participant workers' verification for a measurement", async () => {
      const { failed } = await runTests(
        fixture("multi-user-expected-one-violation.test.tsx"),
        { root: FIXTURES, noIdempotencyCheck: true },
      );
      // This fixture requires a detected violation, so disabling detection
      // must leave its expectation unmet.
      expect(failed).toBe(1);
    });

    it("multi-user: fails when no flagged participant saw a violation", async () => {
      const { passed, failed } = await runTests(
        fixture("multi-user-expected-but-idempotent.test.tsx"),
        { root: FIXTURES },
      );
      // Both participants' own assertions pass; the unmet expectation must
      // add exactly one synthetic failure.
      expect(passed).toBe(2);
      expect(failed).toBe(1);
    });

    it("multi-user: passes when any flagged participant saw a violation", async () => {
      const { passed, failed } = await runTests(
        fixture("multi-user-expected-one-violation.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(2);
      expect(failed).toBe(0);
    });
  },
);
