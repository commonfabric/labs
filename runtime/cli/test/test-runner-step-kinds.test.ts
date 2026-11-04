/**
 * Guard for the step kinds a single-user run has to recognize. `{ label }` and
 * `{ await }` synchronize participants in a multi-user run and carry no work
 * in a single-user one, but the runner still has to know them: a step holding
 * one matched no discriminant and the run reported it as malformed.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/step-kinds");

describe(
  "test-runner",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    describe("a multi-user marker in a single-user run", () => {
      it("is inert and transparent to the reported results", async () => {
        const { passed, failed, results } = await runTests(
          resolve(FIXTURES, "marker-step.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(0);
        expect(passed).toBe(1);
        // Neither marker adds a result, and neither perturbs the one that
        // remains: the `{ await }` sits between the action and the assertion,
        // so the assertion still reports as following that action.
        const steps = results.flatMap((r) => r.results);
        expect(steps.length).toBe(1);
        expect(steps[0].name).toBe("assertion_1");
        expect(steps[0].afterAction).toBe("action_1");
      });
    });
  },
);
