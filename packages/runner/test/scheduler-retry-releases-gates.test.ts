import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { defer } from "@commonfabric/utils/defer";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("scheduler retry releases gates");
const space = signer.did();

const valueSchema = {
  type: "object",
  properties: { value: { type: "number" } },
} as const;

// A reactive computation whose commit is refused for a stale basis is re-run
// after the conflict's catch-up gate (watchReactiveActionCommit). That re-run
// is the scheduler's own, not a fresh input change, so it is queued past the
// node's freshness gates: a trailing debounce or a throttle must not hold it
// (scheduler-v2 §8.3).
//
// The shape that found this: a COLD replica's first run reads a document it
// never synced as absent, commits a `seq: 0` claim over it, and is refused.
// With the debounce re-armed on the re-queue, the retry was a deferred re-run
// of an "already-ran" computation — by design not idle work, and given an
// expiry wake only by a live demander. A one-shot `pull()` has none once it
// resolves, so the retry never ran and the refused first output stood in for
// the computation's answer.
describe("scheduler-owed retries run past the node's freshness gates", () => {
  for (const gate of ["debounce", "throttle"] as const) {
    it(`completes a one-shot pull after a builtin's wait with ${gate}`, async () => {
      const storageManager = EmulatedStorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const attempted = defer<void>();
      const confirmed = defer<void>();
      let ready = false;
      let cancel: (() => void) | undefined;
      try {
        const derived = runtime.getCell(space, "confirmed-output", valueSchema);
        const action: Action = (tx) => {
          if (!ready) {
            tx.addVerdictCallback(() => attempted.resolve());
            return;
          }
          derived.withTx(tx).set({ value: 42 });
        };
        Object.assign(action, { writes: [derived.getAsNormalizedFullLink()] });
        cancel = runtime.scheduler.subscribe(action, {
          [gate]: 60_000,
        });
        storageManager.trackUntilSettled(confirmed.promise.then(() => {
          ready = true;
          runtime.scheduler.invalidateAction(action, { retry: true });
        }));
        const result = derived.pull();
        await attempted.promise;
        confirmed.resolve();
        expect((await result)?.value).toBe(42);
      } finally {
        confirmed.resolve();
        cancel?.();
        await runtime.dispose();
      }
    });
  }

  for (const isEffect of [false, true]) {
    for (const interleaved of [false, true]) {
      it(`keeps a one-shot retry eligible until it runs (effect=${isEffect}, interleaved=${interleaved})`, async () => {
        const storageManager = EmulatedStorageManager.emulate({ as: signer });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
        });
        const attempted = defer<void>();
        const confirmed = defer<void>();
        let ready = false;
        let cancel: (() => void) | undefined;
        try {
          const derived = runtime.getCell(
            space,
            "interleaved-output",
            valueSchema,
          );
          const action: Action = (tx) => {
            if (!ready) {
              tx.addVerdictCallback(() => attempted.resolve());
              return;
            }
            derived.withTx(tx).set({ value: 42 });
          };
          Object.assign(action, {
            writes: [derived.getAsNormalizedFullLink()],
          });
          cancel = runtime.scheduler.subscribe(action, { isEffect });
          storageManager.trackUntilSettled(confirmed.promise.then(() => {
            ready = true;
            runtime.scheduler.invalidateAction(action, { retry: true });
            if (interleaved) runtime.scheduler.invalidateAction(action);
          }));
          const result = derived.pull();
          await attempted.promise;
          runtime.scheduler.setDebounce(action, 60_000);
          const releasedAt = performance.now();
          confirmed.resolve();
          expect((await result)?.value).toBe(42);
          expect(performance.now() - releasedAt).toBeLessThan(60_000);
          runtime.scheduler.invalidateAction(action);
          expect(
            runtime.scheduler.accessForTestingOnly.gates.hasActiveDebounceTimer(
              action,
            ),
          )
            .toBe(true);
        } finally {
          confirmed.resolve();
          cancel?.();
          await runtime.dispose();
        }
      });
    }
  }

  it("preserves a retry requested during a run through that run's completion", async () => {
    const storageManager = EmulatedStorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const started = defer<void>();
    const release = defer<void>();
    let runs = 0;
    let cancel: (() => void) | undefined;
    try {
      const derived = runtime.getCell(space, "during-run-retry", valueSchema);
      const action: Action = async (tx) => {
        if (++runs === 1) {
          started.resolve();
          await release.promise;
          return;
        }
        derived.withTx(tx).set({ value: 42 });
      };
      Object.assign(action, { writes: [derived.getAsNormalizedFullLink()] });
      cancel = runtime.scheduler.subscribe(action);
      const result = derived.pull();
      await started.promise;
      runtime.scheduler.setThrottle(action, 60_000);
      runtime.scheduler.invalidateAction(action, { retry: true });
      const releasedAt = performance.now();
      release.resolve();
      expect((await result)?.value).toBe(42);
      expect(performance.now() - releasedAt).toBeLessThan(60_000);
    } finally {
      release.resolve();
      cancel?.();
      await runtime.dispose();
    }
  });

  /**
   * A writer settles `source` server-side; a cold reader registers a
   * debounced or throttled computation deriving from it, demanded once by a
   * one-shot pull. The computation's first commit claims `source` absent and
   * is refused; the retry after catch-up is what the tests observe.
   */
  async function coldDerivation(
    gate: (runtime: Runtime, action: Action) => void,
  ) {
    const server = newSharedServer();
    const smA = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smA,
    });
    const smB = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtimeB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smB,
    });
    // The harness owns the managers: dispose leaves them open, and each is
    // closed exactly once here.
    const close = async () => {
      await runtimeB.dispose({ closeStorage: false });
      await runtimeA.dispose({ closeStorage: false });
      await smB.close();
      await smA.close();
      await server.close();
    };
    try {
      const txA = runtimeA.edit();
      runtimeA.getCell(space, "gated-retry-source", valueSchema, txA)
        .set({ value: 42 });
      await txA.commit();
      await smA.synced();

      const derived = runtimeB.getCell(
        space,
        "gated-retry-derived",
        valueSchema,
      );
      let runs = 0;
      const action: Action = (tx) => {
        runs++;
        // Cold on the first run: absent, and a `seq: 0` claim the server
        // refuses once the commit reaches it.
        const observed = runtimeB.getCell(
          space,
          "gated-retry-source",
          valueSchema,
          tx,
        ).get();
        derived.withTx(tx).set({ value: observed?.value ?? -1 });
      };
      const derivedLink = derived.getAsNormalizedFullLink();
      Object.assign(action, { writes: [derivedLink] });
      runtimeB.scheduler.subscribe(action, {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(derivedLink)],
      });
      gate(runtimeB, action);

      // The one-shot demand: it runs the computation once and is gone.
      await derived.pull();
      expect(runs).toBe(1);

      // The barrier a client waits on. It spans the refusal, the catch-up,
      // and the re-run — provided the re-run is eligible when queued.
      await runtimeB.settled();

      return { runtimeA, derived, runs: () => runs, close };
    } catch (error) {
      await close();
      throw error;
    }
  }

  it("re-runs a debounced computation after its refused cold commit", async () => {
    const { runtimeA, derived, runs, close } = await coldDerivation(
      (runtime, action) => runtime.scheduler.setDebounce(action, 50),
    );
    try {
      expect(runs()).toBeGreaterThanOrEqual(2);
      expect(derived.get()?.value).toBe(42);
      // Durable, not a local echo: another replica reads the derived value.
      const seenByA = runtimeA.getCell(
        space,
        "gated-retry-derived",
        valueSchema,
      );
      await seenByA.sync();
      expect(seenByA.get()?.value).toBe(42);
    } finally {
      await close();
    }
  });

  it("re-runs a throttled computation after its refused cold commit", async () => {
    // A throttle far longer than the test: its expiry cannot be what runs
    // the retry.
    const { runtimeA, derived, runs, close } = await coldDerivation(
      (runtime, action) => runtime.scheduler.setThrottle(action, 60_000),
    );
    try {
      expect(runs()).toBeGreaterThanOrEqual(2);
      expect(derived.get()?.value).toBe(42);
      const seenByA = runtimeA.getCell(
        space,
        "gated-retry-derived",
        valueSchema,
      );
      await seenByA.sync();
      expect(seenByA.get()?.value).toBe(42);
    } finally {
      await close();
    }
  });
});
