/**
 * How the multi-user orchestrator reads a test step: the orchestrator's half of
 * `test-runner-action-event.test.ts` and `test-runner-step-kinds.test.ts`.
 *
 * A step is classified by which field is present, through a schema that marks
 * the classification-only fields as values the traversal must not descend
 * into. The payload is not classified but sent, so reading it that way
 * delivered every object as `undefined`; and reporting the classified keys
 * back to an author named nothing they had written.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/multi-user-steps");

describe(
  "multi-user-test-runner",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    describe("an action step's event payload", () => {
      it("reaches the handler as authored, nested object included", async () => {
        const { passed, failed } = await runTests(
          resolve(FIXTURES, "event-payload.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(0);
        expect(passed).toBe(1);
      });
    });

    describe("a step carrying no discriminant", () => {
      it("is reported with the step's own keys", async () => {
        // The peek schema has already dropped every key it does not declare,
        // so reporting its keys would name nothing the author wrote.
        const { results } = await runTests(
          resolve(FIXTURES, "invalid-step.test.tsx"),
          { root: FIXTURES },
        );
        expect(results[0].error ?? "").toContain("notAValidStep");
      });
    });
  },
);
