/**
 * A press step: the runner renders the step's view as a browser does and
 * clicks the control it names there, so a handler bound only in the view
 * receives the click from the runner's own runtime.
 */

import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { pressTargetOf } from "../lib/test-press.ts";
import { runTests } from "../lib/test-runner.ts";
import { describe, it } from "@commonfabric/test-support/test";

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

      it("holds the keys its `modifiers` name during the click", async () => {
        const { passed, failed } = await runTests(
          resolve(FIXTURES, "press-modifiers.test.tsx"),
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

      it("throws on `modifiers` naming a key it does not know", () => {
        expect(() => pressTargetOf({ control: "Open", modifiers: ["cmd"] }, 3))
          .toThrow("Test step at index 3 has `modifiers`");
      });
    });
  },
);
