import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import type {
  IExtendedStorageTransaction,
  IStorageTransaction,
} from "../src/storage/interface.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import {
  excludeReadFromConflict,
  internalVerifierRead,
} from "../src/storage/reactivity-log.ts";
import { toMemorySpaceAddress } from "../src/link-types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("absence reconciliation test");
const space = signer.did();

const valueSchema = {
  type: "object",
  properties: { value: { type: "number" } },
} as const;

describe("editWithRetry absence reconciliation", () => {
  // A transaction that reads a document this replica never synced records an
  // absence, which the commit would export as a `seq: 0` confirmed read — a
  // claim the engine rejects whenever the document exists. `editWithRetry`
  // loads such documents before committing and re-runs its action locally
  // when any turn out to exist, so convergence costs local rounds instead of
  // wire rejections. These tests pin the local path apart from the wire path
  // by whether the conflict machinery (`awaitCommitRetryReadiness`) is ever
  // consulted: both paths converge to the same result, only one of them
  // round-trips a doomed commit to get there.
  it("re-runs locally against a document another client already wrote, without a wire conflict", async () => {
    const server = newSharedServer();
    const smA = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smA,
    });
    let smB: EmulatedStorageManager | undefined;
    let runtimeB: Runtime | undefined;
    try {
      // Client A creates the document and settles it server-side.
      const txA = runtimeA.edit();
      runtimeA.getCell(space, "shared-absence-doc", valueSchema, txA)
        .set({ value: 42 });
      await txA.commit();
      await smA.synced();

      // Client B is a cold replica of the same space.
      smB = EmulatedStorageManager.connectTo(server, { as: signer });
      runtimeB = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: smB,
      });
      let readinessConsulted = 0;
      const readiness = runtimeB.awaitCommitRetryReadiness.bind(runtimeB);
      runtimeB.awaitCommitRetryReadiness = (error: unknown) => {
        readinessConsulted++;
        return readiness(error);
      };

      let runs = 0;
      let observed: { value?: number } | undefined;
      const result = await runtimeB.editWithRetry((tx) => {
        runs++;
        // Reads the foreign document cold: absent on the first run, so the
        // read would commit as an absence claim over an existing document.
        observed = runtimeB!.getCell(
          space,
          "shared-absence-doc",
          valueSchema,
          tx,
        ).get();
        runtimeB!.getCell(space, "b-own-doc", valueSchema, tx)
          .set({ value: runs });
      });

      expect(result.error).toBeUndefined();
      // One local re-run: the loaded document changes what the action reads.
      expect(runs).toBe(2);
      expect(observed).toEqual({ value: 42 });
      // The discriminator: convergence never consulted the wire-conflict
      // machinery. Without the pre-commit load, the same outcome arrives via
      // a rejected commit and this counter.
      expect(readinessConsulted).toBe(0);
    } finally {
      await runtimeB?.dispose();
      await runtimeA.dispose();
      await smB?.close();
      await smA.close();
      await server.close();
    }
  });

  it("commits on the first run when the absent documents are absent everywhere", async () => {
    const server = newSharedServer();
    const sm = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    try {
      let runs = 0;
      const result = await runtime.editWithRetry((tx) => {
        runs++;
        // A document nobody ever wrote: the absence is sound, so it commits
        // as an examined absence rather than forcing a re-run.
        runtime.getCell(space, "never-written-doc", valueSchema, tx).get();
        runtime.getCell(space, "own-doc", valueSchema, tx).set({ value: 1 });
      });

      expect(result.error).toBeUndefined();
      expect(runs).toBe(1);
    } finally {
      await runtime.dispose();
      await sm.close();
      await server.close();
    }
  });

  it("leaves a document read by address alone to the commit verdict", async () => {
    const server = newSharedServer();
    const smA = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smA,
    });
    let smB: EmulatedStorageManager | undefined;
    let runtimeB: Runtime | undefined;
    try {
      const txA = runtimeA.edit();
      const shared = runtimeA.getCell(
        space,
        "address-read-doc",
        valueSchema,
        txA,
      );
      shared.set({ value: 5 });
      const address = toMemorySpaceAddress(shared.getAsNormalizedFullLink());
      await txA.commit();
      await smA.synced();

      smB = EmulatedStorageManager.connectTo(server, { as: signer });
      runtimeB = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: smB,
      });
      let readinessConsulted = 0;
      const readiness = runtimeB.awaitCommitRetryReadiness.bind(runtimeB);
      runtimeB.awaitCommitRetryReadiness = (error: unknown) => {
        readinessConsulted++;
        return readiness(error);
      };
      let loadsAwaited = 0;
      const settled = smB.loadsSettled.bind(smB);
      smB.loadsSettled = (keys) => {
        loadsAwaited++;
        return settled(keys);
      };

      let runs = 0;
      const result = await runtimeB.editWithRetry((tx) => {
        runs++;
        // A read by address starts no load, so nothing is in flight for the
        // wait to join: the absence claim goes to the server as it stands.
        tx.read(address);
        runtimeB!.getCell(space, "address-read-own-doc", valueSchema, tx)
          .set({ value: runs });
      });

      expect(result.error).toBeUndefined();
      // Nothing was waited on locally. The server rejects the claim, and the
      // conflict machinery converges it: one wire round, one consult of the
      // retry gate.
      expect(loadsAwaited).toBe(0);
      expect(runs).toBe(2);
      expect(readinessConsulted).toBe(1);
    } finally {
      await runtimeB?.dispose();
      await runtimeA.dispose();
      await smB?.close();
      await smA.close();
      await server.close();
    }
  });

  for (const contentRead of [false, true]) {
    it(`reconciles excluded reads only when CFC consumes their labels (content=${contentRead})`, async () => {
      const server = newSharedServer();
      const writerStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const writerRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: writerStorage,
      });
      let readerStorage: EmulatedStorageManager | undefined;
      let readerRuntime: Runtime | undefined;
      try {
        const excludedAddress = {
          space,
          id: "of:excluded-cold-read-doc" as const,
          type: "application/json" as const,
          scope: "space" as const,
          path: [] as string[],
        };
        const seed = writerRuntime.edit();
        seed.writeValueOrThrow(excludedAddress, { value: 17 });
        expect((await seed.commit()).error).toBeUndefined();
        await writerStorage.synced();

        readerStorage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        readerRuntime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: readerStorage,
        });
        let runs = 0;
        const result = await readerRuntime.editWithRetry((tx) => {
          runs++;
          tx.read(
            excludedAddress,
            {
              meta: contentRead
                ? excludeReadFromConflict
                : { ...excludeReadFromConflict, ...internalVerifierRead },
              nonRecursive: true,
              trackReadWithoutLoad: true,
            },
          );
          readerRuntime!.getCell(
            space,
            "excluded-cold-read-output",
            valueSchema,
            tx,
          ).set({ value: runs });
        });

        expect(result.error).toBeUndefined();
        expect(runs).toBe(contentRead ? 2 : 1);
        const loaded = readerStorage.open(space).replica.getDocument(
          excludedAddress.id,
          excludedAddress.scope,
        );
        if (contentRead) expect(loaded).toBeDefined();
        else expect(loaded).toBeUndefined();
      } finally {
        await readerRuntime?.dispose();
        await writerRuntime.dispose();
        await readerStorage?.close();
        await writerStorage.close();
        await server.close();
      }
    });
  }

  it("falls back to the commit verdict when the provider or the awaited loads fail", async () => {
    const server = newSharedServer();
    const sm = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    const provider = sm.open(space);
    const originalAbsences = provider.unexaminedAbsences;
    const originalSettled = sm.loadsSettled.bind(sm);
    const commitsColdRead = async (name: string): Promise<number> => {
      let runs = 0;
      const result = await runtime.editWithRetry((tx) => {
        runs++;
        runtime.getCell(space, `${name}-cold`, valueSchema, tx).get();
        runtime.getCell(space, `${name}-output`, valueSchema, tx)
          .set({ value: 1 });
      });
      expect(result.error).toBeUndefined();
      return runs;
    };
    try {
      provider.unexaminedAbsences = () => {
        throw new Error("synchronous reconciliation failure");
      };
      expect(await commitsColdRead("provider-failure")).toBe(1);
      provider.unexaminedAbsences = originalAbsences;

      sm.loadsSettled = () => Promise.reject(new Error("awaited load failure"));
      expect(await commitsColdRead("load-failure")).toBe(1);
      sm.loadsSettled = originalSettled;

      // The capability is optional. A provider without it keeps the
      // server-judged commit path.
      provider.unexaminedAbsences = undefined;
      expect(await commitsColdRead("provider-without-capability")).toBe(1);
    } finally {
      provider.unexaminedAbsences = originalAbsences;
      sm.loadsSettled = originalSettled;
      await runtime.dispose();
      await sm.close();
      await server.close();
    }
  });

  it("counts a document that landed as present when another awaited load failed", async () => {
    const server = newSharedServer();
    const smA = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smA,
    });
    let smB: EmulatedStorageManager | undefined;
    let runtimeB: Runtime | undefined;
    try {
      const txA = runtimeA.edit();
      runtimeA.getCell(space, "landed-beside-failure", valueSchema, txA)
        .set({ value: 3 });
      await txA.commit();
      await smA.synced();

      smB = EmulatedStorageManager.connectTo(server, { as: signer });
      runtimeB = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: smB,
      });
      // Every load settles, then the wait reports one of them failed.
      const settled = smB.loadsSettled.bind(smB);
      smB.loadsSettled = (keys) =>
        settled(keys).then(() => Promise.reject(new Error("one load failed")));
      let readinessConsulted = 0;
      const readiness = runtimeB.awaitCommitRetryReadiness.bind(runtimeB);
      runtimeB.awaitCommitRetryReadiness = (error: unknown) => {
        readinessConsulted++;
        return readiness(error);
      };

      let runs = 0;
      let observed: { value?: number } | undefined;
      const result = await runtimeB.editWithRetry((tx) => {
        runs++;
        observed = runtimeB!.getCell(
          space,
          "landed-beside-failure",
          valueSchema,
          tx,
        ).get();
        runtimeB!.getCell(space, "landed-beside-failure-own", valueSchema, tx)
          .set({ value: runs });
      });

      expect(result.error).toBeUndefined();
      expect(runs).toBe(2);
      expect(observed).toEqual({ value: 3 });
      expect(readinessConsulted).toBe(0);
    } finally {
      await runtimeB?.dispose();
      await runtimeA.dispose();
      await smB?.close();
      await smA.close();
      await server.close();
    }
  });

  it("aborts an edit when disposal begins inside its action", async () => {
    const server = newSharedServer();
    const sm = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    let disposing: Promise<void> | undefined;
    try {
      const result = await runtime.editWithRetry((tx) => {
        runtime.getCell(
          space,
          "dispose-before-edit-commit",
          valueSchema,
          tx,
        ).set({ value: 1 });
        // The closing path sets the write gate synchronously before its first
        // awaited teardown barrier. editWithRetry must abort this prepared
        // transaction instead of committing behind disposal.
        disposing = runtime.dispose();
      });

      expect(result.error?.name).toBe("StorageTransactionAborted");
      expect(result.error?.message).toContain("runtime is disposing");
      await disposing;
    } finally {
      await disposing?.catch(() => undefined);
      await sm.close();
      await server.close();
    }
  });

  it("returns a transaction error when commit rejects its promise", async () => {
    const server = newSharedServer();
    const sm = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    const failure = new Error("synthetic commit rejection");
    let attempted: IExtendedStorageTransaction | undefined;
    try {
      const result = await runtime.editWithRetry((tx) => {
        attempted = tx;
        tx.commit = (() => Promise.reject(failure)) as typeof tx.commit;
        return "uncommitted";
      }, 0);

      expect(result.error?.name).toBe("StorageTransactionAborted");
      expect(result.error?.message).toContain("synthetic commit rejection");
      expect((result.error as { reason?: unknown } | undefined)?.reason).toBe(
        failure,
      );
    } finally {
      attempted?.abort("synthetic commit completed");
      await runtime.dispose();
      await sm.close();
      await server.close();
    }
  });

  it("cancels a retry readiness wait when kept-storage disposal begins", async () => {
    const server = newSharedServer();
    const sm = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    const readiness = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    let editing: ReturnType<Runtime["editWithRetry"]> | undefined;
    let disposed = false;
    try {
      editing = runtime.editWithRetry((tx) => {
        tx.commit = (() =>
          Promise.resolve({
            error: {
              name: "ConflictError",
              message: "synthetic conflict with a stuck catch-up gate",
              readyToRetry: () => {
                waiting.resolve();
                return readiness.promise;
              },
            },
          })) as typeof tx.commit;
      });
      await waiting.promise;

      await runtime.dispose({ closeStorage: false });
      disposed = true;

      const outcome = await editing;
      expect(outcome.error?.name).toBe("StorageTransactionAborted");
      expect(outcome.error?.message).toContain("runtime is disposing");
    } finally {
      readiness.resolve();
      await editing?.catch(() => undefined);
      if (!disposed) await runtime.dispose({ closeStorage: false });
      await sm.close();
      await server.close();
    }
  });

  it("stops retry readiness before and between waits when teardown is signaled", async () => {
    const server = newSharedServer();
    const sm = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    try {
      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      let firstGateConsulted = false;
      await runtime.awaitCommitRetryReadiness({
        readyToRetry: () => {
          firstGateConsulted = true;
          return Promise.resolve();
        },
      }, alreadyAborted.signal);
      expect(firstGateConsulted).toBe(true);

      // Model teardown landing after the catch-up gate has settled but before
      // the conflict-document pull begins. The helper removes its listener as
      // it leaves the first wait; making that removal observe the teardown
      // deterministically exercises the same inter-phase race without timing.
      let abortedBetweenWaits = false;
      const interveningSignal = {
        get aborted() {
          return abortedBetweenWaits;
        },
        addEventListener() {},
        removeEventListener() {
          abortedBetweenWaits = true;
        },
      } as unknown as AbortSignal;
      await runtime.awaitCommitRetryReadiness({
        readyToRetry: () => Promise.resolve(),
        conflict: { space, of: "of:must-not-be-pulled" },
      }, interveningSignal);
      expect(abortedBetweenWaits).toBe(true);
    } finally {
      await runtime.dispose();
      await sm.close();
      await server.close();
    }
  });

  it("does not resume a reconciled edit after runtime disposal", async () => {
    const server = newSharedServer();
    const sm = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    const provider = sm.open(space);
    const originalSettled = sm.loadsSettled.bind(sm);
    const reconciliation = Promise.withResolvers<void>();
    let reconciliationCalled = false;
    let disposed = false;
    let outputAddress:
      | ReturnType<typeof toMemorySpaceAddress>
      | undefined;
    try {
      // The cold read below starts a load, and the wait for it is held
      // open here across the disposal.
      sm.loadsSettled = () => {
        reconciliationCalled = true;
        return reconciliation.promise;
      };
      const editing = runtime.editWithRetry((tx) => {
        runtime.getCell(
          space,
          "dispose-during-reconciliation-input",
          valueSchema,
          tx,
        ).get();
        const output = runtime.getCell(
          space,
          "dispose-during-reconciliation-output",
          valueSchema,
          tx,
        );
        outputAddress = toMemorySpaceAddress(
          output.getAsNormalizedFullLink(),
        );
        output.set({ value: 1 });
      });
      expect(reconciliationCalled).toBe(true);

      await runtime.dispose({ closeStorage: false });
      disposed = true;
      reconciliation.resolve();
      const result = await editing;

      expect(result.error?.name).toBe("StorageTransactionAborted");
      expect(
        provider.replica.getDocument(
          outputAddress!.id,
          outputAddress!.scope,
        ),
      ).toBeUndefined();
    } finally {
      sm.loadsSettled = originalSettled;
      reconciliation.resolve();
      if (!disposed) await runtime.dispose({ closeStorage: false });
      await sm.close();
      await server.close();
    }
  });

  it("reconciles the served transaction's user and session instances", async () => {
    const actor = await Identity.fromPassphrase(
      "absence reconciliation served actor",
    );
    const service = await Identity.fromPassphrase(
      "absence reconciliation serving runtime",
    );
    const actorIdentity = {
      principal: actor.did(),
      sessionId: "absence-actor-session",
    };
    const server = newSharedServer();
    let actorStorage: EmulatedStorageManager | undefined =
      EmulatedStorageManager.connectTo(server, {
        as: actor,
        id: actorIdentity.sessionId,
      });
    let actorRuntime: Runtime | undefined = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: actorStorage,
    });
    let servingStorage: EmulatedStorageManager | undefined;
    let servingRuntime: Runtime | undefined;
    let lease: ExecutionLeaseCycle | undefined;
    try {
      const userCell = actorRuntime.getCell<{ value: number }>(
        space,
        "served-identity-user",
        valueSchema,
        undefined,
        "user",
      );
      const sessionCell = actorRuntime.getCell<{ value: number }>(
        space,
        "served-identity-session",
        valueSchema,
        undefined,
        "session",
      );
      const seed = actorRuntime.edit();
      userCell.withTx(seed).set({ value: 11 });
      sessionCell.withTx(seed).set({ value: 22 });
      expect((await seed.commit()).error).toBeUndefined();
      await actorStorage.synced();
      const userId = userCell.getAsNormalizedFullLink().id;
      const sessionId = sessionCell.getAsNormalizedFullLink().id;
      await actorRuntime.dispose();
      actorRuntime = undefined;
      await actorStorage.close();
      actorStorage = undefined;

      const holder = executionLeaseHolder(service.did());
      servingStorage = EmulatedStorageManager.connectTo(server, {
        as: service,
        id: holder,
        servingHomeSpace: space,
      });
      servingRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: servingStorage,
        servingPosture: true,
        experimental: { serverExecution: true },
      });
      const engine = await server.engineForSpace(space);
      lease = new ExecutionLeaseCycle({ engine, space, holder });
      expect(lease.acquire()).toBe(true);

      const tx = servingRuntime.edit();
      stampWaveRunContext(tx, {
        actionId: "reconcile-served-identity",
        kind: "derivation",
        scopeKeyIdentity: actorIdentity,
        actionScopeKey: resolveScopeKey("user", actorIdentity),
      });
      tx.read({
        space,
        id: userId,
        type: "application/json",
        scope: "user",
        path: [],
      }, { trackReadWithoutLoad: true });
      tx.read({
        space,
        id: sessionId,
        type: "application/json",
        scope: "session",
        path: [],
      }, { trackReadWithoutLoad: true });

      const provider = servingStorage.open(space);
      const absences = provider.unexaminedAbsences!(tx.tx);
      expect(absences.map((absence) => absence.id).sort()).toEqual(
        [userId, sessionId].sort(),
      );
      // Each names the actor's instance, the way a load for it is keyed.
      for (const absence of absences) {
        expect(absence.scopeKey).toBe(
          resolveScopeKey(absence.scope, actorIdentity),
        );
      }
      expect(provider.presentCount!(absences)).toBe(0);
      // The loads a served run's reads register name that instance too, and
      // under the key the runtime waits on; once they land, the absences
      // count as present.
      const loads = absences.map((absence) =>
        servingStorage!.syncCell(
          servingRuntime!.getCellFromLink({
            space,
            id: absence.id,
            path: [],
            scope: absence.scope,
          }),
          { scopeKeyIdentity: actorIdentity },
        )
      );
      for (const absence of absences) {
        expect(
          servingStorage.pendingLoadGeneration(
            entityKey(absence, servingRuntime.scopeKeyIdentity),
          ),
        ).toBeDefined();
      }
      await Promise.all(loads);
      expect(provider.presentCount!(absences)).toBe(2);
      expect(
        (provider.replica.getDocument(userId, "user", actorIdentity)?.value as
          | { value?: number }
          | undefined)?.value,
      ).toBe(11);
      expect(
        (provider.replica.getDocument(
          sessionId,
          "session",
          actorIdentity,
        )?.value as { value?: number } | undefined)?.value,
      ).toBe(22);
      // Both loads are keyed under the ACTOR's instance. The serving
      // replica holds no record at all for its OWN instance of either
      // document.
      const replica = provider.replica as SpaceReplica;
      expect(
        replica.accessForTestingOnly.hasDocumentRecord(userId, "user"),
      ).toBe(false);
      expect(
        replica.accessForTestingOnly.hasDocumentRecord(sessionId, "session"),
      ).toBe(false);
      tx.abort("inspection only");
    } finally {
      lease?.release();
      await servingRuntime?.dispose();
      await actorRuntime?.dispose();
      await servingStorage?.close();
      await actorStorage?.close();
      await server.close();
    }
  });

  it("names the unexamined absences through the provider, and counts them present once loaded", async () => {
    const server = newSharedServer();
    const smA = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtimeA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smA,
    });
    let smB: EmulatedStorageManager | undefined;
    let runtimeB: Runtime | undefined;
    try {
      const txA = runtimeA.edit();
      runtimeA.getCell(space, "provider-level-doc", valueSchema, txA)
        .set({ value: 7 });
      await txA.commit();
      await smA.synced();

      smB = EmulatedStorageManager.connectTo(server, { as: signer });
      runtimeB = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: smB,
      });
      const txB = runtimeB.edit();
      const present = runtimeB.getCell(
        space,
        "provider-level-doc",
        valueSchema,
        txB,
      );
      const absent = runtimeB.getCell(
        space,
        "provider-level-absent",
        valueSchema,
        txB,
      );
      const presentAddress = toMemorySpaceAddress(
        present.getAsNormalizedFullLink(),
      );
      const absentAddress = toMemorySpaceAddress(
        absent.getAsNormalizedFullLink(),
      );

      // Recording the reads loads neither document, so what the provider
      // names below cannot depend on a load landing first.
      txB.read(presentAddress, { trackReadWithoutLoad: true });
      txB.read(absentAddress, { trackReadWithoutLoad: true });

      const provider = smB.open(space);
      expect(provider.unexaminedAbsences).toBeDefined();
      expect(provider.unexaminedAbsences!(undefined)).toEqual([]);
      expect(
        provider.unexaminedAbsences!({
          getReadActivities: () => undefined,
        } as unknown as IStorageTransaction),
      ).toEqual([]);

      // A write in another space is irrelevant to this replica's own-write
      // exclusion, and must be skipped rather than keyed here.
      const otherSpace = (await Identity.fromPassphrase(
        "absence reconciliation unrelated space",
      )).did();
      runtimeB.getCell(otherSpace, "unrelated-write", valueSchema, txB)
        .set({ value: 1 });
      // The provider names the documents this replica lacks at the moment
      // it is asked. The list below rests on `provider-level-doc` being one
      // of them, which holds once everything the replica owes has
      // synchronized.
      await smB.synced();
      expect(
        provider.replica.getDocument(presentAddress.id, presentAddress.scope),
      ).toBeUndefined();
      const absences = provider.unexaminedAbsences!(txB.tx);
      expect(absences.map((absence) => absence.id).sort()).toEqual(
        [presentAddress.id, absentAddress.id].sort(),
      );
      for (const absence of absences) {
        expect(absence.space).toBe(space);
        expect(absence.scopeKey).toBeUndefined();
      }
      expect(provider.presentCount!(absences)).toBe(0);
      // Once the loads a read would have started land, exactly the document
      // that exists counts as present.
      await Promise.all([smB.syncCell(present), smB.syncCell(absent)]);
      expect(provider.presentCount!(absences)).toBe(1);
      txB.abort("inspection only");

      // A partial served identity cannot name a session instance on the wire.
      // Leave that absence for ordinary commit admission.
      const incomplete = runtimeB.edit();
      incomplete.tx.scopeKeyIdentity = { principal: signer.did() };
      incomplete.read({
        space,
        id: "of:incomplete-served-session-identity",
        type: "application/json",
        scope: "session",
        path: [],
      }, { trackReadWithoutLoad: true });
      expect(provider.unexaminedAbsences!(incomplete.tx)).toEqual([]);
      incomplete.abort("inspection only");
    } finally {
      await runtimeB?.dispose();
      await runtimeA.dispose();
      await smB?.close();
      await smA.close();
      await server.close();
    }
  });
});
