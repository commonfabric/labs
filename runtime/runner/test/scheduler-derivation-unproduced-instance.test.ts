import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";

import {
  createSigilLinkFromParsedLink,
  toMemorySpaceAddress,
} from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

/**
 * A runtime whose storage manager serves its signer's space when `serving`
 * is set, as a serving runtime's does, and a client runtime otherwise.
 * `holder` holds, at `state`, a link to `state`, a user-scoped document, and
 * at `upstream`, a link to `upstream`, another.
 */
async function fixture(name: string, serving: boolean) {
  const signer = await Identity.fromPassphrase(`unproduced instance ${name}`);
  const space = signer.did();
  const storage = EmulatedStorageManager.emulate({
    as: signer,
    ...(serving ? { servingHomeSpace: space } : {}),
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    servingPosture: serving,
  });
  const state = runtime.getCell<string>(
    space,
    `unproduced-instance-state-${name}`,
    undefined,
    undefined,
    "user",
  );
  const upstream = runtime.getCell<string>(
    space,
    `unproduced-instance-upstream-${name}`,
    undefined,
    undefined,
    "user",
  );
  const holder = runtime.getCell<{ state?: unknown; upstream?: unknown }>(
    space,
    `unproduced-instance-holder-${name}`,
  );
  const output = runtime.getCell<string>(
    space,
    `unproduced-instance-output-${name}`,
  );
  const seed = runtime.edit();
  holder.withTx(seed).set({
    state: state.getAsLink(),
    upstream: upstream.getAsLink(),
  });
  output.withTx(seed).set("as it was");
  expect((await seed.commit().settled).error).toBeUndefined();

  let consumerRuns = 0;
  const consumerOf =
    (read: (tx: IExtendedStorageTransaction) => unknown) =>
    (tx: IExtendedStorageTransaction) => {
      consumerRuns++;
      const value = read(tx);
      output.withTx(tx).set(
        value === undefined ? "derived from nothing" : `derived from ${value}`,
      );
    };
  const subscribeConsumer = async (
    consumer: (tx: IExtendedStorageTransaction) => void,
  ) => {
    runtime.scheduler.subscribe(consumer, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await runtime.idle();
    await storage.synced();
  };

  return {
    runtime,
    storage,
    state,
    output,
    consumerRuns: () => consumerRuns,

    /**
     * Registers a derivation that declares a write to `state`, at `scope`
     * when one is given, and never produces it, as one that has not run yet
     * for this principal, or never does, would.
     */
    registerWriter(scope?: "space" | "user" | "session") {
      const link = state.getAsNormalizedFullLink();
      runtime.scheduler.subscribe(() => {}, {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(scope ? { ...link, scope } : link)],
      });
    },

    /**
     * Registers a derivation that runs as one narrowed to user scope whose
     * result for this principal is `undefined` does: it points the space slot
     * of `state`'s document at the user instance and leaves that instance
     * absent. Waits for it to settle.
     */
    async runEmptyWriter(
      options: { readsUpstream?: boolean; moduleType?: string } = {},
    ) {
      const user = state.getAsNormalizedFullLink();
      const slot = { ...user, scope: "space" as const };
      const writer = (tx: IExtendedStorageTransaction) => {
        if (options.readsUpstream) holder.withTx(tx).key("upstream").get();
        tx.writeValueOrThrow(
          slot,
          createSigilLinkFromParsedLink(user, {
            base: slot,
            overwrite: "redirect",
          }),
        );
      };
      // The module annotation a JavaScript derivation's action carries, or a
      // builtin's when the test names another type.
      Object.assign(writer, {
        module: { type: options.moduleType ?? "javascript" },
      });
      runtime.scheduler.subscribe(writer, {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(slot)],
      });
      await runtime.scheduler.run(writer);
      await runtime.idle();
      await storage.synced();
    },

    /**
     * The key the scheduler reports for `state`'s user instance when a writer
     * that owes it is coming to produce it, asked for a transaction of the
     * consumer's kind, and undefined when none is.
     */
    stateComing: () =>
      runtime.scheduler.comingOwedScopedInstance(
        state.getAsNormalizedFullLink(),
        runtime.edit(),
      ),

    /**
     * Registers a derivation that declares a write to `state` and an effect
     * that reads `state`, which makes the derivation live, so the scheduler
     * queues it. Neither has run when this returns.
     */
    registerQueuedWriter() {
      const link = toMemorySpaceAddress(state.getAsNormalizedFullLink());
      runtime.scheduler.subscribe(() => {}, {
        reads: [],
        shallowReads: [],
        writes: [link],
      });
      runtime.scheduler.subscribe(() => {}, {
        reads: [link],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });
    },

    /**
     * Registers a writer of `state` that the run supply fans out over
     * `demanders` (a piece root resolving to them), runs it once, which
     * narrows it to user instances because it reads `upstream`, a
     * user-scoped document, marks every instance it has invalid, and
     * registers an effect that reads `state` through the space slot, which
     * makes it live. The writer
     * has not run again when this returns.
     */
    async runFannedOutWriter(demanders: () => ScopeKeyIdentity[]) {
      stub(runtime, "serverRunDemandersFor", () => demanders());
      const user = state.getAsNormalizedFullLink();
      const slot = { ...user, scope: "space" as const };
      const writer = (tx: IExtendedStorageTransaction) => {
        upstream.withTx(tx).get();
        tx.writeValueOrThrow(
          slot,
          createSigilLinkFromParsedLink(user, {
            base: slot,
            overwrite: "redirect",
          }),
        );
      };
      Object.assign(writer, {
        schedulerObservationIdentity: {
          pieceId: "fanned-out-root",
          pieceRootId: "fanned-out-root",
        },
      });
      runtime.scheduler.subscribe(writer, {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(slot)],
      });
      await runtime.scheduler.run(writer);
      await runtime.idle();
      runtime.scheduler.invalidateAction(writer);
      // A reader of `state` reads the space slot's redirect on its way to
      // the user instance.
      runtime.scheduler.subscribe(() => {}, {
        reads: [toMemorySpaceAddress(slot), toMemorySpaceAddress(user)],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });
    },

    /**
     * Registers a derivation that declares a write to `upstream` and never
     * produces it.
     */
    registerUpstreamWriter() {
      runtime.scheduler.subscribe(() => {}, {
        reads: [],
        shallowReads: [],
        writes: [toMemorySpaceAddress(upstream.getAsNormalizedFullLink())],
      });
    },

    /**
     * Starts the consumer, which reads `state` through `holder`'s link, and
     * waits for it to settle.
     */
    runConsumer: () =>
      subscribeConsumer(
        consumerOf((tx) => holder.withTx(tx).key("state").get()),
      ),

    /**
     * Starts a consumer that reads `state` through `holder`'s link and throws
     * while it reads nothing there, as a computation that dereferences the
     * value does, and waits for it to settle.
     */
    runThrowingConsumer: () =>
      subscribeConsumer(
        consumerOf((tx) => {
          const value = holder.withTx(tx).key("state").get();
          if (value === undefined) throw new TypeError("read nothing");
          return value;
        }),
      ),

    /**
     * Starts a consumer that reads `state` directly, following no link, and
     * waits for it to settle.
     */
    runDirectConsumer: () =>
      subscribeConsumer(consumerOf((tx) => state.withTx(tx).get())),

    async close() {
      await storage.synced();
      await runtime.dispose();
      await storage.close();
    },
  };
}

describe("scheduler-derivation-unproduced-instance", () => {
  it("commits nothing from a served derivation that read a scoped instance a registered derivation has not produced, and commits once it is produced", async () => {
    const f = await fixture("served", true);
    try {
      f.registerWriter();
      await f.runConsumer();

      expect(f.consumerRuns()).toBe(1);
      expect(f.output.get()).toBe("as it was");

      const produce = f.runtime.edit();
      f.state.withTx(produce).set("the instance");
      expect((await produce.commit().settled).error).toBeUndefined();
      await f.runtime.idle();
      await f.storage.synced();

      expect(f.consumerRuns()).toBe(2);
      expect(f.output.get()).toBe("derived from the instance");
    } finally {
      await f.close();
    }
  });

  it("reports no error from a served derivation that threw after reading a scoped instance not yet produced, and commits once it is produced", async () => {
    // The throw is the absence's consequence, as the value it would have
    // committed is, so the run is withdrawn rather than reported.

    const f = await fixture("thrown", true);
    const errors: Error[] = [];
    f.runtime.scheduler.onError((error) => errors.push(error));
    try {
      f.registerWriter();
      await f.runThrowingConsumer();

      expect(f.consumerRuns()).toBe(1);
      expect(errors).toEqual([]);
      expect(f.output.get()).toBe("as it was");

      const produce = f.runtime.edit();
      f.state.withTx(produce).set("the instance");
      expect((await produce.commit().settled).error).toBeUndefined();
      await f.runtime.idle();
      await f.storage.synced();

      expect(f.consumerRuns()).toBe(2);
      expect(f.output.get()).toBe("derived from the instance");
    } finally {
      await f.close();
    }
  });

  it("reports the error of a served derivation that threw after reading a missing scoped instance no registered derivation writes", async () => {
    const f = await fixture("thrown-authored", true);
    const errors: Error[] = [];
    f.runtime.scheduler.onError((error) => errors.push(error));
    try {
      await f.runThrowingConsumer();

      expect(f.consumerRuns()).toBe(1);
      expect(errors.map((error) => error.message)).toEqual(["read nothing"]);
    } finally {
      await f.close();
    }
  });

  it("commits the output of a served derivation that read a scoped instance its registered derivation ran and left absent", async () => {
    // A writer that has run for the instance has produced it, and its value
    // is `undefined`: the absence is the instance's state.

    const f = await fixture("ran-empty", true);
    try {
      await f.runEmptyWriter();
      await f.runConsumer();

      expect(f.consumerRuns()).toBe(1);
      expect(f.output.get()).toBe("derived from nothing");
    } finally {
      await f.close();
    }
  });

  it("commits nothing from a served derivation that read a scoped instance a builtin writer ran and left absent", async () => {
    // A builtin can write its output after its run returns, so its finished
    // run shows nothing about whether it has produced the instance.

    const f = await fixture("ran-empty-builtin", true);
    try {
      await f.runEmptyWriter({ moduleType: "raw" });
      await f.runConsumer();

      expect(f.consumerRuns()).toBe(1);
      expect(f.output.get()).toBe("as it was");
    } finally {
      await f.close();
    }
  });

  it("commits nothing from a served derivation that read a scoped instance whose writer's run was withdrawn for reading one not yet produced", async () => {
    // A writer whose run was withdrawn has not produced its instance: what it
    // left absent is not its output, so the reader waits as for one that has
    // not run.

    const f = await fixture("withdrawn-writer", true);
    try {
      f.registerUpstreamWriter();
      await f.runEmptyWriter({ readsUpstream: true });
      await f.runConsumer();

      expect(f.consumerRuns()).toBe(1);
      expect(f.output.get()).toBe("as it was");
    } finally {
      await f.close();
    }
  });

  it("wakes a watch on a document when a writer of it finishes a run that leaves its instance absent", async () => {
    // Such a run commits no write to the instance, so a waiter on the
    // instance learns of it only from the watch.

    const f = await fixture("watch-produced", true);
    try {
      let woken = 0;
      f.runtime.scheduler.watchProducedDocument(
        f.state.getAsNormalizedFullLink(),
        () => woken++,
      );
      await f.runEmptyWriter();

      expect(woken).toBe(1);
    } finally {
      await f.close();
    }
  });

  it("reports an owed instance as coming while a writer that owes it is queued to run", async () => {
    const f = await fixture("coming-queued", true);
    try {
      f.registerQueuedWriter();

      expect(f.stateComing()).toBe(
        resolveScopeKey("user", f.runtime.scopeKeyIdentity),
      );
    } finally {
      await f.close();
    }
  });

  it("reports an owed instance as coming from a fanned-out writer whose demanders include the reading principal", async () => {
    const f = await fixture("coming-fanned-out-demanded", true);
    try {
      await f.runFannedOutWriter(() => [f.runtime.scopeKeyIdentity]);

      expect(f.stateComing()).toBe(
        resolveScopeKey("user", f.runtime.scopeKeyIdentity),
      );
    } finally {
      await f.close();
    }
  });

  it("reports an owed instance as not coming from a fanned-out writer no demander of which is the reading principal", async () => {
    // The run supply runs only the instances its current demanders
    // produce, so a principal nothing demands the writer for gets no run of
    // it, whatever its instance's dirtiness.

    const other = await Identity.fromPassphrase("unproduced instance other");
    const f = await fixture("coming-fanned-out-undemanded", true);
    try {
      await f.runFannedOutWriter(() => [
        { principal: other.did(), sessionId: "other-session" },
      ]);

      expect(f.stateComing()).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it("reports an owed instance as not coming when the only writer that owes it is dormant", async () => {
    // A derivation nothing demands is never queued, so nothing is coming to
    // produce the instance.

    const f = await fixture("coming-dormant", true);
    try {
      f.registerWriter();
      await f.runtime.idle();

      expect(f.stateComing()).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it("commits nothing from a served derivation whose instance a registered derivation never produces, leaving the earlier value standing", async () => {
    // A writer that never produces this principal's instance holds its
    // readers' served commits back for as long as that lasts.

    const f = await fixture("never", true);
    try {
      f.registerWriter();
      await f.runConsumer();

      expect(f.consumerRuns()).toBe(1);
      expect(f.output.get()).toBe("as it was");
    } finally {
      await f.close();
    }
  });

  it("commits nothing from a served derivation that read a user-scoped instance of a document a registered derivation declares at space scope", async () => {
    // A derivation's output is declared at its binding's scope and written
    // at the scope its reads narrow to, so a writer declared at any scope
    // may be the one that produces this instance.

    const f = await fixture("narrowed", true);
    try {
      f.registerWriter("space");
      await f.runConsumer();

      expect(f.consumerRuns()).toBe(1);
      expect(f.output.get()).toBe("as it was");
    } finally {
      await f.close();
    }
  });

  it("commits the output of a served derivation that read a missing scoped instance directly, following no link", async () => {
    // A run that addresses the document itself, as a builtin reads its own
    // store before it mints it, reads the missing row as knowledge.

    const f = await fixture("direct", true);
    try {
      f.registerWriter();
      await f.runDirectConsumer();

      expect(f.consumerRuns()).toBe(1);
      expect(f.output.get()).toBe("derived from nothing");
    } finally {
      await f.close();
    }
  });

  it("commits the output of a served derivation that read a missing scoped instance no registered derivation writes", async () => {
    const f = await fixture("authored", true);
    try {
      await f.runConsumer();

      expect(f.consumerRuns()).toBe(1);
      expect(f.output.get()).toBe("derived from nothing");
    } finally {
      await f.close();
    }
  });

  it("commits the output of a client derivation that read a scoped instance a registered derivation has not produced", async () => {
    const f = await fixture("client", false);
    try {
      f.registerWriter();
      await f.runConsumer();

      expect(f.consumerRuns()).toBe(1);
      expect(f.output.get()).toBe("derived from nothing");
    } finally {
      await f.close();
    }
  });
});
