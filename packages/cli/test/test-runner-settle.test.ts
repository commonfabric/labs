/**
 * Guard for the `{ settle: true }` test step: the runner waits for full
 * settlement (`runtime.settled()`) between steps, honors `skip`, and the step is
 * transparent to the reported results (it is neither an action nor an
 * assertion). Mirrors test-runner-console-capture.test.ts.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/settle");

function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

describe(
  "`{ settle: true }` test step",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("prints separate initialization, action, assertion, and settle read reports", async () => {
      const output: string[] = [];
      using _log = stub(console, "log", (...args: unknown[]) => {
        output.push(args.map(String).join(" "));
      });
      const result = await runTests(fixture("settle-step.test.tsx"), {
        root: FIXTURES,
        verbose: true,
        statsThreshold: 0,
      });
      expect(result.failed).toBe(0);
      const reports = output.filter((line) => line.includes("Read cost ("));
      for (
        const interval of [
          "initialization",
          "action_1",
          "settle_1",
          "assertion_1",
          "settle_3",
        ]
      ) {
        expect(
          reports.some((line) => line.includes(`Read cost (${interval})`)),
        ).toBe(true);
      }
      expect(reports.find((line) => line.includes("settle_3"))).toContain(
        "0 runs, 0 accesses",
      );
    });

    it("runs a full settle between steps and is transparent to results", async () => {
      const { passed, failed, results } = await runTests(
        fixture("settle-step.test.tsx"),
        { root: FIXTURES },
      );
      // Only the single assertion is reported; the settle steps add nothing.
      expect(failed).toBe(0);
      expect(passed).toBe(1);
      const stepResults = results.flatMap((r) => r.results);
      expect(stepResults.length).toBe(1);
      expect(stepResults.every((r) => !r.name.startsWith("settle_"))).toBe(
        true,
      );
    });

    it("rejects a step with no supported discriminant", async () => {
      const { results } = await runTests(
        fixture("invalid-step.test.tsx"),
        { root: FIXTURES },
      );
      expect(results[0].error ?? "").toContain(
        "must have an 'action', 'assertion', 'render', 'settle', 'label', " +
          "or 'await'",
      );
      // The step's own key, not the empty list the peek schema leaves behind.
      expect(results[0].error ?? "").toContain('Got: `["notAValidStep"]`');
    });
  },
);
