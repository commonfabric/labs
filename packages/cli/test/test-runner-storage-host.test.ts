/**
 * Guard for `TestRunnerOptions.storageHost`: the runner runs against a
 * caller-supplied identity and store, records what the run instantiates, and
 * leaves that store OPEN and readable once the run returns.
 *
 * The caller this exists for is the pattern-vintage capture
 * (`tasks/pattern-vintage-run.ts`), which snapshots the store afterwards — so
 * the seam is checked here rather than only through the gate that consumes it.
 *
 * The read below goes through the SAME manager, so what it pins is "still open
 * and its state still reachable through it", not durability: a regression that
 * stopped flushing at teardown would leave this green. That is the right scope
 * — the capture's own `snapshot()` does `idle()` + `synced()` before copying
 * the file, so durability-at-return was never this seam's job. Durability is
 * witnessed through an independent manager in
 * `packages/runner/test/runtime-dispose-keep-storage.test.ts`.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { withEnv } from "./utils.ts";
import { runTestPattern, runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/storage-host");

/** Pinned, because an id that differs every run cannot be addressed again. */
const RESULT_CAUSE = { cliStorageHost: "counter" };

const SCHEMA = {
  type: "object",
  properties: { count: { type: "number" } },
} as const;

describe(
  "runTestPattern with a caller-supplied storage host",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("leaves the store readable, holding what the run wrote", async () => {
      const identity = await Identity.fromPassphrase("cli storage host test");
      const storageManager = StorageManager.emulate({ as: identity });
      const instantiated: string[] = [];

      const result = await runTestPattern(
        resolve(FIXTURES, "counter.test.tsx"),
        {
          root: FIXTURES,
          storageHost: {
            identity,
            storageManager,
            resultCause: RESULT_CAUSE,
            onPatternInstantiated: (i) => instantiated.push(i.identity),
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.results.filter((r) => !r.passed && !r.skipped)).toEqual([]);
      // The observer is how the capture learns what to replay later; a run that
      // recorded nothing would produce a fixture with no update targets.
      expect(instantiated.length).toBeGreaterThan(0);

      // The runner tore its own runtime down but did NOT close this manager, so
      // a fresh runtime over it reads the state the handlers wrote — two bumps,
      // durable, addressable by the cause the caller pinned.
      const reader = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const root = reader.getCell<{ count: number }>(
        identity.did(),
        RESULT_CAUSE,
        SCHEMA,
      );
      await root.sync();
      expect(root.get()?.count).toBe(2);

      // The caller owns the close, which is the other half of the contract.
      await reader.dispose();
    });

    it("preserves an existing home pattern when the storage host requests it", async () => {
      const identity = await Identity.fromPassphrase(
        "cli storage host preserved home",
      );
      const storageManager = StorageManager.emulate({ as: identity });
      const owner = new Runtime({
        apiUrl: new URL("https://fabric.example"),
        storageManager,
      });
      const home = owner.getCell<{ marker: string }>(
        identity.did(),
        "caller-home",
      );
      await owner.editWithRetry((tx) => {
        home.withTx(tx).set({ marker: "caller-owned" });
        owner.getHomeSpaceCell(tx).key("defaultPattern").set(home);
      });
      try {
        const result = await runTestPattern(
          resolve(FIXTURES, "counter.test.tsx"),
          {
            root: FIXTURES,
            storageHost: {
              identity,
              storageManager,
              preserveDefaultPattern: true,
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.results.every((step) => step.passed)).toBe(true);
        await owner.getHomeSpaceCell().sync();
        const actual = owner.getHomeSpaceCell().key("defaultPattern")
          .resolveAsCell();
        expect(actual.equals(home)).toBe(true);
      } finally {
        await owner.dispose();
      }
    });

    it("uses the supplied API origin for agent queue entries", async () => {
      const identity = await Identity.fromPassphrase(
        "cli storage host API origin",
      );
      const storageManager = StorageManager.emulate({ as: identity });
      const owner = new Runtime({
        apiUrl: new URL("https://fabric.example"),
        storageManager,
      });
      await owner.editWithRetry((tx) => {
        owner.getCell(identity.did(), "default-pattern", undefined, tx)
          .key("agentQueue").set({ entries: [] });
      });
      try {
        await withEnv("EXPERIMENTAL_AGENT_BUILTIN", "true", async () => {
          const result = await runTestPattern(
            resolve(FIXTURES, "agent-host.test.tsx"),
            {
              root: FIXTURES,
              storageHost: {
                identity,
                storageManager,
                apiUrl: new URL("https://fabric.example"),
              },
            },
          );
          expect(result.error).toBeUndefined();
          expect(result.results.filter((step) => !step.passed)).toEqual([]);
        });
      } finally {
        await owner.dispose();
      }
    });

    it("awaits the storage host's external work before reading assertions", async () => {
      const identity = await Identity.fromPassphrase("cli external work");
      const storageManager = StorageManager.emulate({ as: identity });
      const storageHost = {
        identity,
        storageManager,
        // Starting the write from `then` makes the test fail if the runner
        // invokes this hook without awaiting the returned work.
        beforeAssertions: (runtime: Runtime, result: Cell<unknown>) =>
          ({
            then: async (resolve, reject) => {
              try {
                const written = await runtime.editWithRetry((tx) => {
                  result.key("ready").withTx(tx).set(true);
                });
                expect(written.error).toBeUndefined();
                resolve?.();
              } catch (error) {
                reject?.(error);
              }
            },
          }) as Promise<void>,
      };
      try {
        const result = await runTestPattern(
          resolve(FIXTURES, "external-agent.test.tsx"),
          {
            root: FIXTURES,
            storageHost,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.results).toHaveLength(1);
        expect(result.results[0].passed).toBe(true);
      } finally {
        await storageManager.close();
      }
    });

    it("reports rejected external work without executing the assertions", async () => {
      const identity = await Identity.fromPassphrase(
        "cli rejected external work",
      );
      const storageManager = StorageManager.emulate({ as: identity });
      const storageHost = {
        identity,
        storageManager,
        beforeAssertions: () =>
          Promise.reject(new Error("external agent failed")),
      };
      try {
        const result = await runTestPattern(
          resolve(FIXTURES, "external-agent.test.tsx"),
          {
            root: FIXTURES,
            storageHost,
          },
        );
        expect(result.error).toContain("external agent failed");
        expect(result.results).toEqual([]);
      } finally {
        await storageManager.close();
      }
    });

    it("RAISES a teardown that does not complete", async () => {
      // The other half of "the store is the caller's": the caller is about to
      // read what this run wrote, so a teardown that did not finish must not be
      // reported as a completed run. `captureVintage` turns the throw into a
      // refused capture rather than a fixture silently missing state.
      //
      // Driven by a store whose `synced()` always rejects, which is what the
      // teardown drain awaits. The run itself fails too — that is fine and not
      // what this pins; the claim is that the failure REACHES the caller rather
      // than being logged and swallowed.
      const identity = await Identity.fromPassphrase("cli storage host raise");
      const wedged = StorageManager.emulate({ as: identity });
      // Patched on the INSTANCE, not through a Proxy: the manager reads private
      // class fields, and a Proxy receiver makes `#telemetry` throw before the
      // wedge under test is ever reached.
      (wedged as { synced: () => Promise<void> }).synced = () =>
        Promise.reject(new Error("wedged store"));

      await expect(
        runTestPattern(resolve(FIXTURES, "counter.test.tsx"), {
          root: FIXTURES,
          storageHost: {
            identity,
            storageManager: wedged,
            resultCause: RESULT_CAUSE,
          },
        }),
      ).rejects.toThrow("wedged store");

      await wedged.close();
    });

    it("counts a raised teardown per file and keeps the run going", async () => {
      // The raise is right for a DIRECT caller and wrong for a multi-file run:
      // one wedged file must not take the remaining files' results with it.
      // Two paths, both wedged — a `failed` of 2 is what says the loop got past
      // the first one rather than aborting on it.
      const identity = await Identity.fromPassphrase("cli storage host suite");
      const wedged = StorageManager.emulate({ as: identity });
      (wedged as { synced: () => Promise<void> }).synced = () =>
        Promise.reject(new Error("wedged store"));
      const fixture = resolve(FIXTURES, "counter.test.tsx");

      const { failed } = await runTests([fixture, fixture], {
        root: FIXTURES,
        storageHost: { identity, storageManager: wedged },
      });

      expect(failed).toBe(2);

      await wedged.close();
    });
  },
);
