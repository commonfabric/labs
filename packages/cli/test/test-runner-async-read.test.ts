/**
 * Contract tests for an assertion whose own read starts an async built-in:
 * the runner waits for that work and reads again, and a wait that fails is
 * reported as the assertion's failure.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { resolve } from "@std/path";
import { Runtime } from "@commonfabric/runner";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/async-read");

function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

describe(
  "test-runner async read",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("waits for the async work an assertion's own read starts", async () => {
      const { passed, failed, results } = await runTests(
        fixture("delayed-read.test.tsx"),
        { root: FIXTURES },
      );
      expect(failed).toBe(0);
      expect(passed).toBe(1);
      expect(results[0].results[0].error).toBeUndefined();
    });

    it("reports a wait for async work that fails as the assertion's failure", async () => {
      // The fixture has no `settle` step, so the first bare `settled()` call
      // is the wait the assertion's read triggers; later calls run as normal
      // so teardown drains the fetch the read started.
      const settled = Runtime.prototype.settled;
      let rejected = false;
      using _settled = stub(Runtime.prototype, "settled", function (maxRounds) {
        if (maxRounds === undefined && !rejected) {
          rejected = true;
          return Promise.reject(new Error("async work never settled"));
        }
        return settled.call(this, maxRounds);
      });
      const { failed, results } = await runTests(
        fixture("delayed-read.test.tsx"),
        { root: FIXTURES },
      );
      expect(rejected).toBe(true);
      expect(failed).toBe(1);
      expect(results[0].results[0].error).toContain("async work never settled");
    });
  },
);
