import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { getServerExecutionConfig } from "@commonfabric/memory/v2";
import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type ActiveLogLevel, getLogger } from "@commonfabric/utils/logger";
import { withEnv } from "./utils.ts";
import { runTestPattern, runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures");

/** The logger a served fetch logs through, counted though never printed. */
const servedFetchLogger = getLogger("cf-test-served-fetch", { enabled: false });

/**
 * Runs the `served-logger` fixture on the server-execution arm with the
 * process's `fetch` replaced by one that logs at `level` and answers the
 * fixture's request. The fixture's fetch is the serving loop's alone, so what
 * that logs is the loop's.
 */
async function runServedFetch(
  level: ActiveLogLevel,
): Promise<Awaited<ReturnType<typeof runTests>>> {
  const root = resolve(FIXTURES, "served-logger");
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    servedFetchLogger[level]("served-fetch", "the served fetch logged");
    return Promise.resolve(
      new Response('{"v":7}', {
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    let outcome: Awaited<ReturnType<typeof runTests>> | undefined;
    await withEnv("EXPERIMENTAL_SERVER_EXECUTION", "true", async () => {
      outcome = await runTests(resolve(root, "served-fetch.test.tsx"), {
        root,
      });
    });
    return outcome!;
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe(
  "cf test with server execution on",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("serves a single-user handler that instantiates a pattern in a space of its own", async () => {
      // The child's space is created by the handler, so the served run is the
      // only one that lands it; a speculative run's echo is withdrawn.
      const root = resolve(FIXTURES, "in-space");
      let outcome: Awaited<ReturnType<typeof runTests>> | undefined;
      await withEnv("EXPERIMENTAL_SERVER_EXECUTION", "true", async () => {
        outcome = await runTests(resolve(root, "create-in-handler.test.tsx"), {
          root,
        });
      });
      expect(outcome?.failed).toBe(0);
      expect(outcome?.passed).toBe(2);
    });

    it("serves a multi-user participant's handler that instantiates a pattern in a space of its own", async () => {
      // As in the single-user case, and the participant reads the child
      // right after its action, so the read holds only when the action's
      // settle waited for the served write to arrive.
      const root = resolve(FIXTURES, "in-space");
      let outcome: Awaited<ReturnType<typeof runTests>> | undefined;
      await withEnv("EXPERIMENTAL_SERVER_EXECUTION", "true", async () => {
        outcome = await runTests(
          resolve(root, "create-in-participant-handler.test.tsx"),
          { root },
        );
      });
      expect(outcome?.failed).toBe(0);
      expect(outcome?.passed).toBe(1);
    });

    it("delivers a participant's served write to the participant awaiting its marker", async () => {
      // Alice's write is a handler's, so on this arm the serving loop makes
      // it. Bob reads it once, after Alice's marker, so the assertion holds
      // only when the loop served it before the marker was announced.
      const root = resolve(FIXTURES, "multi-user-markers");
      let outcome: Awaited<ReturnType<typeof runTests>> | undefined;
      await withEnv("EXPERIMENTAL_SERVER_EXECUTION", "true", async () => {
        outcome = await runTests(resolve(root, "marker-barrier.test.tsx"), {
          root,
        });
      });
      expect(outcome?.failed).toBe(0);
      expect(outcome?.passed).toBe(1);
      expect(outcome?.results[0].results[0].name).toBe("bob/assertion_1");
    });

    it("reports a handler's throw once when both of its runs hit it", async () => {
      // The speculative run's error and the served run's `errored` outcome
      // name the same event, which is what pairs them.
      const root = resolve(FIXTURES, "served-errors");
      let outcome: Awaited<ReturnType<typeof runTests>> | undefined;
      await withEnv("EXPERIMENTAL_SERVER_EXECUTION", "true", async () => {
        outcome = await runTests(resolve(root, "throwing-action.test.tsx"), {
          root,
        });
      });
      expect(outcome?.results[0].runtimeErrors).toStrictEqual([
        "Error: the handler threw",
      ]);
    });

    it("reports a serving-loop logger warning apart from the test's own, and passes", async () => {
      const outcome = await runServedFetch("warn");
      expect(outcome.passed).toBe(1);
      expect(outcome.failed).toBe(0);
      expect(outcome.results[0].consoleWarnings).toStrictEqual([]);
      expect(outcome.results[0].servedWarnings).toStrictEqual([
        "[served] [logger:cf-test-served-fetch] 1 warning(s) (key: served-fetch)",
      ]);
    });

    it("fails on a serving-loop logger error, marked as served", async () => {
      const outcome = await runServedFetch("error");
      expect(outcome.passed).toBe(1);
      expect(outcome.failed).toBe(1);
      expect(outcome.results[0].consoleErrors).toStrictEqual([
        "[served] [logger:cf-test-served-fetch] 1 error(s) (key: served-fetch)",
      ]);
    });

    it("closes its serving loop when the runtime cannot be built", async () => {
      // A live serving host holds the process's server-execution flag on, so
      // the flag reads as on after the run exactly when the loop is left
      // running. An unknown CFC mode fails the runtime's construction, which
      // comes after the loop starts and before the run's own `try`.
      expect(getServerExecutionConfig()).toBe(false);
      const dir = await Deno.makeTempDir({ prefix: "cf-test-on-setup-" });
      try {
        await withEnv("EXPERIMENTAL_SERVER_EXECUTION", "true", async () => {
          await expect(
            runTestPattern(resolve(dir, "never-read.test.tsx"), {
              root: dir,
              cfcEnforcementMode: "unknown" as CfcEnforcementMode,
            }),
          ).rejects.toThrow('Runtime `cfcEnforcementMode` is "unknown"');
        });
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
      expect(getServerExecutionConfig()).toBe(false);
    });

    it("rejects a run against a caller-supplied storage host", async () => {
      // The refusal comes before the file is read, so a runner that did not
      // refuse fails on the missing file instead, with another message.
      const dir = await Deno.makeTempDir({ prefix: "cf-test-on-host-" });
      const identity = await Identity.fromPassphrase("cf-test-on-host");
      const storageManager = StorageManager.emulate({ as: identity });
      try {
        await withEnv("EXPERIMENTAL_SERVER_EXECUTION", "true", async () => {
          await expect(
            runTestPattern(resolve(dir, "never-read.test.tsx"), {
              root: dir,
              storageHost: { identity, storageManager },
            }),
          ).rejects.toThrow(
            "`cf test` refuses a caller-supplied `storageHost` on the " +
              "server-execution arm",
          );
        });
      } finally {
        await storageManager.close();
        await Deno.remove(dir, { recursive: true });
      }
    });
  },
);
