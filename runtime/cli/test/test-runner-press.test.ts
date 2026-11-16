/**
 * A press step: the runner renders the step's view as a browser does and
 * clicks the control it names there, so a handler bound only in the view
 * receives the click from the runner's own runtime.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/press");

describe(
  "test-runner",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    describe("a press step", () => {
      it("clicks the one control its `within` text picks out", async () => {
        const { passed, failed } = await runTests(
          resolve(FIXTURES, "press-row.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(0);
        expect(passed).toBe(1);
      });

      it("fails, pressing nothing, when more than one control answers", async () => {
        const { passed, results } = await runTests(
          resolve(FIXTURES, "press-ambiguous.test.tsx"),
          { root: FIXTURES },
        );
        expect(passed).toBe(0);
        expect(JSON.stringify(results)).toContain(
          'found 2 controls showing \\"Remove\\"',
        );
      });
    });
  },
);
