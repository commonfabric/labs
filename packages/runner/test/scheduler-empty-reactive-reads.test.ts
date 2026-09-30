import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  acquireExecutionLease,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";

import { stampWaveRunContext } from "../src/executor/wave.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { MAX_RETRIES_FOR_REACTIVE } from "../src/scheduler/constants.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";

async function fixture(sealing = false) {
  const signer = await Identity.fromPassphrase("empty reactive reads");
  const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
  const storage = EmulatedStorageManager.connectTo(server, { as: signer });
  if (sealing) {
    const engine = await server.engineForSpace(signer.did());
    expect(acquireExecutionLease(engine, {
      space: signer.did(),
      holder: executionLeaseHolder(signer.did()),
      now: Date.now(),
      ttlMs: 600_000,
    })).toBe(true);
  }
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    servingPosture: sealing,
    experimental: { serverExecution: sealing },
  });
  const destination = {
    seal: (tx: IExtendedStorageTransaction) => {
      if (!tx.tx.sealInto) throw new Error("Expected a sealing transaction");
      return tx.tx.sealInto({
        sealSpaceCommit: (space, native, source) => {
          const replica = storage.open(space).replica;
          if (!replica.commitNative) throw new Error("Expected native commits");
          return replica.commitNative(native, source);
        },
      });
    },
  };
  return {
    runtime,
    storage,
    space: signer.did(),
    destination,
    async close() {
      runtime.clearSealDestination();
      await storage.synced();
      await runtime.dispose();
      await server.close();
    },
  };
}

describe("scheduler-empty-reactive-reads", () => {
  for (const stale of [false, true]) {
    it(`validates reads after writes cancel out in multiple spaces with stale input ${stale}`, async () => {
      const { runtime, space, close } = await fixture();
      const otherSpace = (await Identity.fromPassphrase("other empty space"))
        .did();
      const input = runtime.getCell<number>(space, "multi-space-input");
      const outputs = [space, otherSpace].map((outputSpace) =>
        runtime.getCell<number>(outputSpace, "multi-space-output")
      );
      try {
        const seed = runtime.edit();
        seed.tx.enableMultiSpaceWrites!();
        input.withTx(seed).set(0);
        for (const output of outputs) output.withTx(seed).set(0);
        expect((await seed.commit()).error).toBeUndefined();

        const tx = runtime.edit();
        tx.tx.enableMultiSpaceWrites!();
        tx.tx.validateReactiveReads = true;
        expect(input.withTx(tx).get()).toBe(0);
        for (const output of outputs) {
          output.withTx(tx).set(1);
          output.withTx(tx).set(0);
        }
        if (stale) {
          const update = runtime.edit();
          input.withTx(update).set(1);
          expect((await update.commit()).error).toBeUndefined();
        }

        const reads = tx.tx.getReactivityLog!().reads;
        expect(reads.length).toBeGreaterThan(0);
        const result = await tx.commit();
        if (stale) {
          expect(result.error).toMatchObject({
            name: "StorageTransactionInconsistent",
            emptyReactiveCommit: true,
          });
          expect(tx.tx.getReactivityLog!().reads).toEqual(reads);
        } else {
          expect(result.error).toBeUndefined();
        }
        expect(outputs.map((output) => output.get())).toEqual([0, 0]);
      } finally {
        await close();
      }
    });
  }

  for (const hasBranch of [false, true]) {
    it(`aborts an untracked reactive read without throwing with an existing branch ${hasBranch}`, async () => {
      const { runtime, storage, space, close } = await fixture();
      try {
        const address = toMemorySpaceAddress(
          runtime.getCell(space, "missing-snapshot").getAsNormalizedFullLink(),
        );
        const tx = storage.edit();
        tx.validateReactiveReads = true;
        if (hasBranch) {
          expect(
            tx.read({ ...address, id: "of:other-document", path: [] }).error,
          )
            .toBeUndefined();
        }
        // Model a future read recorder that appends activity without first
        // creating its snapshot. Commit must fail closed, not throw TypeError.
        tx.getReactivityLog = () => ({
          reads: [address],
          shallowReads: [],
          writes: [],
        });
        expect((await tx.commit()).error).toMatchObject({
          name: "StorageTransactionAborted",
          abortedBeforeStorage: true,
          reason:
            `Reactive read has no transaction snapshot: ${space}/${address.id}`,
        });
      } finally {
        await close();
      }
    });
  }

  for (const sealing of [false, true]) {
    it(`flushes an effect-only event after its input changes with sealing ${sealing}`, async () => {
      const { runtime, space, destination, close } = await fixture(sealing);
      const input = runtime.getCell<number>(space, "event-input");
      const event = runtime.getCell<number>(space, "event");
      const read = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let attempts = 0;
      let flushed = 0;
      let abandoned = 0;
      let status: string | undefined;
      try {
        const seed = runtime.edit();
        input.withTx(seed).set(0);
        expect((await seed.commit()).error).toBeUndefined();
        if (sealing) runtime.installSealDestination(destination);
        runtime.scheduler.addEventHandler(async (tx) => {
          attempts++;
          expect(input.withTx(tx).get()).toBe(0);
          tx.enqueuePostCommitEffect({
            id: "effect-only-handler",
            kind: "test",
            flush() {
              flushed++;
            },
            abandon() {
              abandoned++;
            },
          });
          read.resolve();
          await resume.promise;
        }, event.getAsNormalizedFullLink());
        runtime.scheduler.queueEvent(
          event.getAsNormalizedFullLink(),
          1,
          false,
          (tx) => {
            status = tx.status().status;
          },
        );
        await read.promise;
        const update = runtime.edit();
        input.withTx(update).set(1);
        expect((await update.commit()).error).toBeUndefined();
        resume.resolve();
        await runtime.settled();
        expect(attempts).toBe(1);
        expect(status).toBe("done");
        expect(flushed).toBe(1);
        expect(abandoned).toBe(0);
      } finally {
        resume.resolve();
        await close();
      }
    });
  }

  for (const shallow of [false, true]) {
    it(`accepts unchanged dependencies despite a sibling write with shallow reads ${shallow}`, async () => {
      const { runtime, space, close } = await fixture();
      const input = runtime.getCell<{ value: number; noise: number }>(
        space,
        "input",
      );
      let runs = 0;
      let cancel: (() => void) | undefined;
      try {
        const seed = runtime.edit();
        input.withTx(seed).set({ value: 0, noise: 0 });
        expect((await seed.commit()).error).toBeUndefined();
        const action = async (tx: IExtendedStorageTransaction) => {
          runs++;
          if (shallow) {
            tx.tx.read(toMemorySpaceAddress(input.getAsNormalizedFullLink()), {
              nonRecursive: true,
            });
          } else {
            expect(input.withTx(tx).key("value").get()).toBe(0);
          }
          // The first attempt races an unrelated change. Holding the writer
          // to one update lets an erroneous retry finish and fail the count.
          if (runs === 1) {
            const update = runtime.edit();
            input.withTx(update).key("noise").set(1);
            expect((await update.commit()).error).toBeUndefined();
          }
        };
        cancel = runtime.scheduler.subscribe(action, { isEffect: true });
        await runtime.settled();
        expect(runs).toBe(1);
      } finally {
        cancel?.();
        await close();
      }
    });
  }

  for (const shallow of [false, true]) {
    for (const initiallyPresent of [false, true]) {
      it(`recomputes when an undefined field changes presence from ${initiallyPresent} with shallow reads ${shallow}`, async () => {
        const { runtime, space, close } = await fixture();
        const input = runtime.getCell<{ field?: undefined }>(space, "input");
        const address = toMemorySpaceAddress(
          input.key("field").getAsNormalizedFullLink(),
        );
        let runs = 0;
        let cancel: (() => void) | undefined;
        try {
          const seed = runtime.edit();
          input.withTx(seed).set(initiallyPresent ? { field: undefined } : {});
          expect((await seed.commit()).error).toBeUndefined();
          cancel = runtime.scheduler.subscribe(async (tx) => {
            expect(tx.tx.read(address, { nonRecursive: shallow }).error)
              .toBeUndefined();
            if (++runs === 1) {
              const update = runtime.edit();
              input.withTx(update).set(
                initiallyPresent ? {} : { field: undefined },
              );
              expect((await update.commit()).error).toBeUndefined();
            }
          }, { isEffect: true });
          await runtime.settled();
          expect(runs).toBe(2);
        } finally {
          cancel?.();
          await close();
        }
      });
    }
  }

  it("recomputes when a shallow read gains a key", async () => {
    const { runtime, space, close } = await fixture();
    const input = runtime.getCell<Record<string, number>>(space, "input");
    let runs = 0;
    let cancel: (() => void) | undefined;
    try {
      const seed = runtime.edit();
      input.withTx(seed).set({ first: 0 });
      expect((await seed.commit()).error).toBeUndefined();
      cancel = runtime.scheduler.subscribe(async (tx) => {
        expect(
          tx.tx.read(toMemorySpaceAddress(input.getAsNormalizedFullLink()), {
            nonRecursive: true,
          }).error,
        ).toBeUndefined();
        if (++runs === 1) {
          const update = runtime.edit();
          input.withTx(update).key("second").set(1);
          expect((await update.commit()).error).toBeUndefined();
        }
      }, { isEffect: true });
      await runtime.settled();
      expect(runs).toBe(2);
    } finally {
      cancel?.();
      await close();
    }
  });

  it("converges after a dependency changes beyond the bounded retry budget", async () => {
    const { runtime, space, close } = await fixture();
    const input = runtime.getCell<number>(space, "input");
    const changes = MAX_RETRIES_FOR_REACTIVE + 2;
    let runs = 0;
    let seen: number | undefined;
    let cancel: (() => void) | undefined;
    try {
      const seed = runtime.edit();
      input.withTx(seed).set(0);
      expect((await seed.commit()).error).toBeUndefined();
      cancel = runtime.scheduler.subscribe(async (tx) => {
        seen = input.withTx(tx).get();
        if (++runs <= changes) {
          const update = runtime.edit();
          input.withTx(update).set(runs);
          expect((await update.commit()).error).toBeUndefined();
        }
      }, { isEffect: true });
      await runtime.settled();
      expect(runs).toBe(changes + 1);
      expect(seen).toBe(changes);
    } finally {
      cancel?.();
      await close();
    }
  });

  for (const gate of ["debounce", "throttle"] as const) {
    it(`recomputes a stale no-op from a one-shot pull past ${gate}`, async () => {
      const { runtime, space, close } = await fixture();
      const input = runtime.getCell<number>(space, "input");
      const output = runtime.getCell<number>(space, "output");
      let runs = 0;
      let cancel: (() => void) | undefined;
      try {
        const seed = runtime.edit();
        input.withTx(seed).set(0);
        output.withTx(seed).set(0);
        expect((await seed.commit()).error).toBeUndefined();
        const action = Object.assign(
          async (tx: IExtendedStorageTransaction) => {
            const value = input.withTx(tx).get();
            if (++runs === 1) {
              const update = runtime.edit();
              input.withTx(update).set(1);
              expect((await update.commit()).error).toBeUndefined();
            }
            output.withTx(tx).set(value);
          },
          { writes: [output.getAsNormalizedFullLink()] },
        );
        cancel = runtime.scheduler.subscribe(action, {
          reads: [],
          shallowReads: [],
          writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
        });
        if (gate === "debounce") runtime.scheduler.setDebounce(action, 60_000);
        else runtime.scheduler.setThrottle(action, 60_000);
        await output.pull();
        await runtime.settled();
        expect(output.get()).toBe(1);
        expect(runs).toBe(2);
      } finally {
        cancel?.();
        await close();
      }
    });
  }

  it("keeps a live computation's throttle after a stale empty run", async () => {
    const { runtime, space, close } = await fixture();
    const input = runtime.getCell<number>(space, "input");
    let runs = 0;
    let seen: number | undefined;
    let cancel: (() => void) | undefined;
    try {
      const seed = runtime.edit();
      input.withTx(seed).set(0);
      expect((await seed.commit()).error).toBeUndefined();
      const action = async (tx: IExtendedStorageTransaction) => {
        seen = input.withTx(tx).get();
        if (++runs === 2) {
          const update = runtime.edit();
          input.withTx(update).set(2);
          expect((await update.commit()).error).toBeUndefined();
        }
      };
      cancel = runtime.scheduler.subscribe(action, { isEffect: true });
      await runtime.settled();
      expect(runs).toBe(1);
      runtime.scheduler.setThrottle(action, 1000);
      const update = runtime.edit();
      input.withTx(update).set(1);
      const committed = update.commit();
      await clock.settle();
      expect((await committed).error).toBeUndefined();
      await clock.tick(1000);
      await clock.settle();
      expect(runs).toBe(2);
      await clock.tick(1000);
      await clock.settle();
      expect(runs).toBe(3);
      expect(seen).toBe(2);
    } finally {
      cancel?.();
      await close();
    }
  });

  it("watches an instance while a later fan-out instance is still running", async () => {
    const { runtime, space, destination, close } = await fixture(true);
    const identities = [
      { principal: "did:key:alice", sessionId: "alice" },
      { principal: "did:key:bob", sessionId: "bob" },
    ];
    const shared = runtime.getCell<number>(space, "shared");
    const scoped = runtime.getCellFromLink<number>({
      ...runtime.getCell(space, "scoped").getAsNormalizedFullLink(),
      scope: "user",
    });
    const bobRead = Promise.withResolvers<void>();
    const resumeBob = Promise.withResolvers<void>();
    const runs: string[] = [];
    const observed = new Map<string, number[]>();
    let cancel: (() => void) | undefined;
    try {
      const seed = runtime.edit();
      shared.withTx(seed).set(0);
      expect((await seed.commit()).error).toBeUndefined();
      runtime.installSealDestination(destination, {
        runStamper: (tx, info) =>
          stampWaveRunContext(tx, {
            actionId: info.actionId,
            kind: info.kind,
            scopeKeyIdentity: info.scopeKeyIdentity,
            actionScopeKey: info.actionScopeKey,
          }),
        runDemanderResolver: () => identities,
      });
      const action = Object.assign(async (tx: IExtendedStorageTransaction) => {
        const principal = tx.tx.scopeKeyIdentity!.principal!;
        runs.push(principal);
        // The scoped read discovers the per-principal fan-out. Alice's
        // first run is a no-op and finishes before Bob opens this gate.
        scoped.withTx(tx).get();
        if (principal === identities[1].principal && runs.length === 2) {
          bobRead.resolve();
          await resumeBob.promise;
        }
        const values = observed.get(principal) ?? [];
        values.push(shared.withTx(tx).get());
        observed.set(principal, values);
      }, { schedulerObservationIdentity: { pieceRootId: "fan-out-root" } });
      cancel = runtime.scheduler.subscribe(action, { isEffect: true });
      await bobRead.promise;
      expect(runs).toEqual(identities.map(({ principal }) => principal));
      const update = runtime.edit();
      shared.withTx(update).set(1);
      expect((await update.commit()).error).toBeUndefined();
      resumeBob.resolve();
      await runtime.settled();
      expect(observed.get(identities[0].principal)).toEqual([0, 1]);
      expect(observed.get(identities[1].principal)?.at(-1)).toBe(1);
      expect(runs.filter((principal) => principal === identities[0].principal))
        .toHaveLength(2);
    } finally {
      resumeBob.resolve();
      cancel?.();
      await close();
    }
  });
});
