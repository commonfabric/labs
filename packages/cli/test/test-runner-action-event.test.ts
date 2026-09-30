/**
 * Guard for an action step's `event` payload: the runner sends what the step
 * authored, whatever its shape. The step is read through a schema that marks
 * the classification-only fields as values not to descend into; the payload is
 * not one of those, and reading it that way delivered `undefined` in place of
 * every object.
 *
 * Also here: a payload holding a link to a cell whose type carries a write
 * policy. The steps are the test pattern's own result, so storing them has to
 * satisfy that policy unless the link is typed as the handler's event declares.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/action-event");

describe(
  "test-runner",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    describe("an action step's event payload", () => {
      it("reaches the handler as authored, for a primitive and an object", async () => {
        const { passed, failed } = await runTests(
          resolve(FIXTURES, "event-payload.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(0);
        expect(passed).toBe(2);
      });

      it("keeps the gesture's own `type` when the step adds a payload", async () => {
        // A record payload extends the click rather than replacing it, which
        // is what the browser-parity harness in
        // `packages/patterns/integration/multi-runtime-worker.ts` does.
        const { passed, failed } = await runTests(
          resolve(FIXTURES, "trusted-gesture.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(0);
        expect(passed).toBe(1);
      });
    });

    describe("a link in the event to a cell whose type has a write policy", () => {
      // `docs/common/workflows/pattern-testing.md`, "Putting a cell link in an
      // event", describes both of these.

      it("reaches the handler when held in a local typed as the event declares", async () => {
        const { passed, failed } = await runTests(
          resolve(FIXTURES, "policy-link-typed.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(0);
        expect(passed).toBe(1);
      });

      it("fails the test's setup when typed as the cell itself", async () => {
        const { passed, results } = await runTests(
          resolve(FIXTURES, "policy-link-inferred.test.tsx"),
          { root: FIXTURES },
        );
        expect(passed).toBe(0);
        expect(results.flatMap((result) => result.consoleWarnings).join())
          .toContain("write-policy-gate");
      });
    });
  },
);
