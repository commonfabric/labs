/**
 * A press step's naming of the control it presses, and its report of a view
 * that fails to render.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { pressTargetOf } from "../lib/test-press.ts";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(
  import.meta.dirname!,
  "fixtures/test-runner-edge-cases",
);

describe(
  "test-press",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    describe("pressTargetOf()", () => {
      it("returns the control a step names, with its `within` text when given", () => {
        expect(pressTargetOf({ control: "Remove" }, 0)).toEqual({
          control: "Remove",
        });
        expect(pressTargetOf({ control: "Remove", within: "pear" }, 0))
          .toEqual({ control: "Remove", within: "pear" });
      });

      it("throws for a step naming no control, giving its index", () => {
        expect(() => pressTargetOf({}, 3)).toThrow(
          "Test step at index 3 presses a control but names none in `control`",
        );
        expect(() => pressTargetOf({ control: 7 }, 3)).toThrow(
          "names none in `control`",
        );
      });

      it("throws for a `within` that is not a string, giving the step's index", () => {
        expect(() => pressTargetOf({ control: "Remove", within: 1 }, 2))
          .toThrow("Test step at index 2 has a `within` that is not a string");
      });
    });

    describe("pressRenderedControl()", () => {
      it("fails the step when its view cannot be rendered", async () => {
        const { passed, failed, results } = await runTests(
          resolve(FIXTURES, "press-invalid-view.test.tsx"),
          { root: FIXTURES },
        );
        expect(passed).toBe(0);
        expect(failed).toBe(1);
        expect(results[0].error).toContain("A press step's view failed:");
      });
    });
  },
);
