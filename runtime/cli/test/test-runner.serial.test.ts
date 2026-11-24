/**
 * How `cf test` reports a test file whose shape is wrong and a file that
 * allows its runtime errors, what it prints for a verbose run and for its
 * storage statistics, and how it reports a run whose runtime, settlement, or
 * serving loop fails underneath it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { resolve } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { runTestPattern, runTests } from "../lib/test-runner.ts";
import { withEnv } from "./utils.ts";

const FIXTURES = resolve(
  import.meta.dirname!,
  "fixtures/test-runner-edge-cases",
);

function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

/**
 * What `run` returned, and each line `console.log` and `console.error`
 * receive while it runs. What `console.warn` and `console.debug` receive is
 * dropped.
 */
async function logged<T>(
  run: () => Promise<T>,
): Promise<{ output: string[]; errors: string[]; result: T }> {
  const output: string[] = [];
  const errors: string[] = [];
  const collect = (lines: string[]) => (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  using _log = stub(console, "log", collect(output));
  using _error = stub(console, "error", collect(errors));
  using _warn = stub(console, "warn", () => {});
  using _debug = stub(console, "debug", () => {});
  return { output, errors, result: await run() };
}

describe(
  "test-runner",
  () => {
    describe("a file of the wrong shape", () => {
      it("fails a module with no default export", async () => {
        const { result } = await logged(() =>
          runTests(fixture("no-default.test.tsx"), { root: FIXTURES })
        );
        expect(result.failed).toBe(1);
        expect(result.results[0].error).toBe(
          "Test pattern must export a pattern function as default",
        );
      });

      it("fails a default export that is neither a pattern nor a multi-user descriptor, naming its type", async () => {
        const { result } = await logged(() =>
          runTests(fixture("object-default.test.tsx"), { root: FIXTURES })
        );
        expect(result.failed).toBe(1);
        expect(result.results[0].error).toBe(
          "Test pattern must export a pattern function as default, got object",
        );
      });

      it("fails a default export that is a function but not a pattern, saying so", async () => {
        const { result } = await logged(() =>
          runTests(fixture("plain-function-default.test.tsx"), {
            root: FIXTURES,
          })
        );
        expect(result.failed).toBe(1);
        expect(result.results[0].error).toBe(
          "Test pattern must export a pattern function as default, got a function that is not a pattern",
        );
      });

      it("fails a pattern whose `[TESTS]` is not a list", async () => {
        const { result } = await logged(() =>
          runTests(fixture("tests-not-array.test.tsx"), { root: FIXTURES })
        );
        expect(result.failed).toBe(1);
        expect(result.results[0].error).toBe(
          "Test pattern must return { [TESTS]: TestStep[] }. Got: undefined",
        );
      });
    });

    it("passes a file that allows the runtime error it raises", async () => {
      const { result: { passed, failed, results } } = await logged(() =>
        runTests(fixture("allowed-runtime-error.test.tsx"), { root: FIXTURES })
      );
      expect(results[0].allowRuntimeErrors).toBe(true);
      expect(results[0].runtimeErrors).toHaveLength(1);
      expect(results[0].runtimeErrors[0]).toContain(
        "intentional fixture throw",
      );
      expect(passed).toBe(1);
      expect(failed).toBe(0);
    });

    it("leaves out console output a pattern body writes as its module is evaluated", async () => {
      const { result: { passed, failed, results } } = await logged(() =>
        runTests(fixture("module-console.test.tsx"), { root: FIXTURES })
      );
      expect(results[0].consoleErrors).toEqual([]);
      expect(passed).toBe(1);
      expect(failed).toBe(0);
    });

    describe("verbose output", () => {
      it("prints each navigation an action makes, by the target's name", async () => {
        const { output, result } = await logged(() =>
          runTests(fixture("navigate.test.tsx"), {
            root: FIXTURES,
            verbose: true,
          })
        );
        expect(result.failed).toBe(0);
        expect(output).toContain("    → navigateTo: Navigation target");
        expect(output).toContain("  📍 1 navigation(s): Navigation target");
      });

      it("prints no navigation line for a run that makes none", async () => {
        const { output, result } = await logged(() =>
          runTests(fixture("settle-only.test.tsx"), {
            root: FIXTURES,
            verbose: true,
          })
        );
        expect(result.failed).toBe(0);
        expect(output.some((line) => line.includes("navigat"))).toBe(false);
      });
    });

    describe("storage statistics", () => {
      it("prints the storage loggers' activity when asked, up to the limit given", async () => {
        const { output, result } = await logged(() =>
          runTests(fixture("settle-only.test.tsx"), {
            root: FIXTURES,
            storageStats: true,
            storageStatsLimit: 1,
          })
        );
        expect(result.failed).toBe(0);
        expect(output.some((line) => line.includes("| Storage totals:")))
          .toBe(true);
        expect(output).toContain("           Timings (top 1 by p95):");
      });

      it("prints none when not asked", async () => {
        const { output } = await logged(() =>
          runTests(fixture("settle-only.test.tsx"), { root: FIXTURES })
        );
        expect(output.some((line) => line.includes("Storage totals"))).toBe(
          false,
        );
      });
    });

    describe("a failure beneath the run", () => {
      it("fails the file when a `{ settle: true }` step's settlement fails", async () => {
        const settled = Runtime.prototype.settled;
        using _settled = stub(
          Runtime.prototype,
          "settled",
          function (maxRounds) {
            if (maxRounds === undefined) {
              return Promise.reject(new Error("settlement refused"));
            }
            return settled.call(this, maxRounds);
          },
        );
        const { result } = await logged(() =>
          runTests(fixture("settle-only.test.tsx"), { root: FIXTURES })
        );
        expect(result.failed).toBe(1);
        expect(result.results[0].error).toContain("settlement refused");
      });

      it("fails an assertion whose value cannot be read, saying so", async () => {
        // The store's session ends once the assertion's wait for async work
        // is over, which is the first unbounded settlement after the hook
        // that runs before the steps.
        const identity = await Identity.fromPassphrase("test-runner");
        const storageManager = StorageManager.emulate({ as: identity });
        await using _storage = {
          [Symbol.asyncDispose]: () => storageManager.close(),
        };
        let stepsBegun = false;
        let sessionEnded = false;
        const sessionError = storageManager.spaceSessionError.bind(
          storageManager,
        );
        storageManager.spaceSessionError = (space) =>
          sessionEnded ? new Error("session ended") : sessionError(space);
        const settled = Runtime.prototype.settled;
        using _settled = stub(
          Runtime.prototype,
          "settled",
          async function (maxRounds) {
            await settled.call(this, maxRounds);
            if (stepsBegun && maxRounds === undefined) sessionEnded = true;
          },
        );
        const { result } = await logged(() =>
          runTestPattern(fixture("assertion-only.test.tsx"), {
            root: FIXTURES,
            storageHost: {
              identity,
              storageManager,
              serverExecution: false,
              beforeAssertions: () => {
                stepsBegun = true;
                return Promise.resolve();
              },
            },
          })
        );
        expect(sessionEnded).toBe(true);
        expect(result.error).toBeUndefined();
        expect(result.results).toEqual([{
          name: "assertion_1",
          passed: false,
          afterAction: null,
          error: "Error reading assertion: session ended",
          durationMs: expect.any(Number),
        }]);
      });

      it("reports an unmeasured read budget beside the failure of the step it belongs to", async () => {
        // The first unbounded settlement is the initialization budget's; the
        // second is the step's, which fails.
        const settled = Runtime.prototype.settled;
        let budgetSettles = 0;
        using _settled = stub(
          Runtime.prototype,
          "settled",
          function (maxRounds) {
            if (maxRounds === Infinity && ++budgetSettles === 2) {
              return Promise.reject(new Error("budget settlement refused"));
            }
            return settled.call(this, maxRounds);
          },
        );
        const { result } = await logged(() =>
          runTests(fixture("budgeted-invalid-step.test.tsx"), {
            root: FIXTURES,
          })
        );
        expect(result.failed).toBe(1);
        const error = result.results[0].error ?? "";
        expect(error).toContain("must have an 'action'");
        expect(error).toContain(
          "step 1: read budget measurement incomplete because settlement " +
            "failed: Error: budget settlement refused",
        );
      });

      it("fails the file, after logging why, when the serving loop fails to close", async () => {
        const close = ExecutorHost.prototype.close;
        using _close = stub(
          ExecutorHost.prototype,
          "close",
          async function () {
            await close.call(this);
            throw new Error("serving loop close refused");
          },
        );
        let outcome: Awaited<ReturnType<typeof runTests>> | undefined;
        let output: string[] = [];
        let errors: string[] = [];
        await withEnv("EXPERIMENTAL_SERVER_EXECUTION", "true", async () => {
          ({ output, errors, result: outcome } = await logged(() =>
            runTests(fixture("settle-only.test.tsx"), { root: FIXTURES })
          ));
        });
        expect(outcome?.failed).toBe(1);
        expect(
          errors.some((line) =>
            line.includes("[cf test] closing the serving loop failed for") &&
            line.includes("serving loop close refused")
          ),
        ).toBe(true);
        expect(
          output.some((line) => line.includes("serving loop close refused")),
        ).toBe(true);
      });

      it("keeps a served commit CFC refused among the warnings of a run that errors", async () => {
        let outcome: Awaited<ReturnType<typeof runTests>> | undefined;
        await withEnv("EXPERIMENTAL_SERVER_EXECUTION", "true", async () => {
          ({ result: outcome } = await logged(() =>
            runTests(fixture("refused-then-invalid.test.tsx"), {
              root: FIXTURES,
            })
          ));
        });
        const result = outcome!.results[0];
        expect(result.error).toContain("must have an 'action'");
        expect(
          (result.consoleWarnings ?? []).some((line) =>
            line.startsWith("[served]")
          ),
        ).toBe(true);
      });
    });
  },
);
