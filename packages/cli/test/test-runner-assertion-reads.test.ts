/**
 * How many times `cf test` reads an assertion before reporting it.
 *
 * Exactly once, whatever the assertion is and whatever it turns out to say.
 * Reading a second time would decide the count by the first read's outcome,
 * which is how a pattern whose value converges only sometimes comes to be
 * reported as correct.
 */

import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTestPattern, type TestRunResult } from "../lib/test-runner.ts";

const fixtures = resolve(import.meta.dirname!, "fixtures");

interface FixtureRun {
  readonly result: TestRunResult;

  /**
   * The evaluations the runner performed for one assertion step, each named by
   * the part of its phase label that distinguishes it, in the order they ran.
   */
  evaluationsOf(assertionName: string): string[];
}

/**
 * Run one fixture and capture the phase marks it left. The runner clears the
 * timeline as it starts, so those marks are its own; capturing them is what
 * keeps a later run from clearing the evidence a case is about to read.
 */
async function runFixture(path: string): Promise<FixtureRun> {
  const result = await runTestPattern(resolve(fixtures, path));
  const marks = performance.getEntriesByType("mark").map((entry) => entry.name);
  return {
    result,
    evaluationsOf(assertionName: string): string[] {
      const prefix = `cf-test/runTestPattern/step/${assertionName}/`;
      return marks
        .filter((name) =>
          name.startsWith(prefix) && name.includes("/evaluate:start#")
        )
        .map((name) => name.slice(prefix.length).replace(/:start#\d+$/, ""));
    },
  };
}

describe("test-runner assertion reads", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  describe("an assertion step after an action", () => {
    let run: FixtureRun;

    beforeAll(async () => {
      run = await runFixture("assertion-reads/after-action.test.tsx");
    });

    it("reads one that holds once", () => {
      expect(run.result.results[0]).toMatchObject({
        name: "assertion_1",
        passed: true,
      });
      expect(run.evaluationsOf("assertion_1")).toEqual(["evaluate"]);
    });

    it("reads one that does not hold once, and reports it as failed", () => {
      expect(run.result.results[1]).toMatchObject({
        name: "assertion_2",
        passed: false,
      });
      expect(run.evaluationsOf("assertion_2")).toEqual(["evaluate"]);
    });

    it("reports nothing else", () => {
      expect(run.result.error).toBeUndefined();
      expect(run.result.results).toHaveLength(2);
    });
  });

  describe("an assertion whose value an async built-in produces", () => {
    let run: FixtureRun;

    beforeAll(async () => {
      run = await runFixture("async-read/delayed-read.test.tsx");
    });

    it("reads it once, after the work its own demand started", () => {
      expect(run.evaluationsOf("assertion_1")).toEqual(["evaluate"]);
    });

    it("passes it", () => {
      expect(run.result.error).toBeUndefined();
      expect(run.result.results.map(({ passed }) => passed)).toEqual([true]);
    });
  });
});
