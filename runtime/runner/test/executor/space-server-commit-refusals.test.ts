import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { markEffectCompletion } from "../../src/executor/effect-completion.ts";
import { SpaceServer } from "../../src/executor/space-server.ts";
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import { Runtime } from "../../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  ISpaceReplica,
  MemorySpace,
} from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("commit refusals space");
const space = spaceSigner.did() as MemorySpace;
const foreignSigner = await Identity.fromPassphrase("commit refusals foreign");
const foreign = foreignSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("commit refusals service");

const EFFECT_KEY = "fetchJson:refusal-test@of:refusal-result";

const db: SqliteDbRef = { id: "of:commit-refusals-db" };

/** `tx`, with its storage offering no way to seal it. */
const unsealable = (
  tx: IExtendedStorageTransaction,
): IExtendedStorageTransaction => {
  tx.tx.sealInto = undefined;
  return tx;
};

describe("SpaceServer", () => {
  let server: MemoryV2Server.Server;
  let engine: Engine.Engine;
  let runtime: Runtime;
  let serving: SpaceServer;
  /** The message the next wave commit is refused with, if any. */
  let refuseNextCommit: string | undefined;

  beforeEach(async () => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    engine = await server.engineForSpace(space);
    await server.engineForSpace(foreign);
    refuseNextCommit = undefined;
    const manager = EmulatedStorageManager.connectTo(server, {
      as: serviceSigner,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    serving = new SpaceServer({
      space,
      engine,
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: () =>
        Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        }),
      decorateWaveCommitSink: (sink) => ({
        currentHeads: (target, docs) => sink.currentHeads(target, docs),
        concurrentWritePaths: (target, doc, sinceSeq) =>
          sink.concurrentWritePaths(target, doc, sinceSeq),
        commitWave: (batch) => {
          const message = refuseNextCommit;
          if (message === undefined) return sink.commitWave(batch);
          refuseNextCommit = undefined;
          return Promise.resolve({
            error: { name: "WaveCommitRejected", message },
          });
        },
      }),
      localSeqRef: { value: 0 },
      stats: emptyServingLoopStats(),
      policy: { flushDeadlineMs: 2_000, idleParkMs: 600_000 },
    });
    expect(await serving.activate()).toBe(true);
  });

  afterEach(async () => {
    try {
      await serving.park("test-teardown");
    } finally {
      await server.close();
    }
  });

  /** A synced cell `name` in `target`, as the serving runtime sees it. */
  const syncedCell = async (target: MemorySpace, name: string) => {
    const cell = runtime.getCell<{ n: number }>(target, name, undefined);
    await cell.sync();
    return cell;
  };

  /** The value the store holds for `cell`'s document in `target`. */
  const stored = async (
    target: MemorySpace,
    cell: { getAsNormalizedFullLink(): { id: string } },
  ) =>
    Engine.read(await server.engineForSpace(target), {
      id: cell.getAsNormalizedFullLink().id,
    })?.value;

  const replicaOf = (target: MemorySpace): ISpaceReplica =>
    runtime.storageManager.open(target).replica;

  const warnings = (key: string): number =>
    getLogger("space-server").countsByKey[key]?.warn ?? 0;

  describe("instance members", () => {
    describe("seal()", () => {
      describe("an effect completion", () => {
        /** A transaction marked as `EFFECT_KEY`'s completion. */
        const completion = (
          tx: IExtendedStorageTransaction = runtime.edit(),
        ): IExtendedStorageTransaction => {
          markEffectCompletion(tx, EFFECT_KEY);
          return tx;
        };

        it("commits its write to the serving space as a commit of its own", async () => {
          const cell = await syncedCell(space, "completion-commits");
          const tx = completion();
          cell.withTx(tx).set({ n: 1 });

          expect((await tx.commit().settled).error).toBeUndefined();
          expect(await stored(space, cell)).toEqual({ n: 1 });
        });

        it("returns a refusal naming the park when the tenure parks before the seal is taken up", async () => {
          const cell = await syncedCell(space, "completion-parked");
          const tx = completion();
          cell.withTx(tx).set({ n: 1 });

          const sealing = serving.seal(tx);
          const parking = serving.park("test-park");
          const refused = await sealing;
          await parking;

          expect(refused.error?.message).toContain(
            "effect completion arrived while the space is parked",
          );
          expect(await stored(space, cell)).toBeUndefined();
        });

        it("returns a refusal for a transaction whose storage cannot seal", async () => {
          const refused = await serving.seal(
            completion(unsealable(runtime.edit())),
          );

          expect(refused.error?.message).toBe(
            "storage transaction does not support sealing",
          );
          expect(refused.error).toMatchObject({
            reason: expect.objectContaining({
              message: "effect-completion-refused",
            }),
          });
        });

        it("returns the seal's failure, withdrawing the spaces already sealed, when a written space's replica cannot seal", async () => {
          const home = await syncedCell(space, "completion-home");
          const away = await syncedCell(foreign, "completion-away");
          const tx = completion();
          tx.enableMultiSpaceWrites?.([space, foreign]);
          home.withTx(tx).set({ n: 1 });
          away.withTx(tx).set({ n: 2 });
          const foreignReplica = replicaOf(foreign);
          foreignReplica.sealNative = undefined;
          let refused;
          try {
            refused = await tx.commit().settled;
          } finally {
            delete foreignReplica.sealNative;
          }
          await runtime.storageManager.synced();

          expect(refused.error?.message).toBe(
            `space replica for ${foreign} does not support sealing`,
          );
          expect(home.get()).toBeUndefined();
          expect(await stored(space, home)).toBeUndefined();
        });

        it("returns a refusal, withdrawing every write, when it writes a space it does not serve", async () => {
          const home = await syncedCell(space, "completion-home");
          const away = await syncedCell(foreign, "completion-away");
          const tx = completion();
          tx.enableMultiSpaceWrites?.([space, foreign]);
          home.withTx(tx).set({ n: 1 });
          away.withTx(tx).set({ n: 2 });

          const refused = await tx.commit().settled;
          await runtime.storageManager.synced();

          expect(refused.error?.message).toContain(
            "effect completion wrote a foreign space",
          );
          expect(home.get()).toBeUndefined();
          expect(away.get()).toBeUndefined();
          expect(await stored(space, home)).toBeUndefined();
          expect(await stored(foreign, away)).toBeUndefined();
        });

        it("returns a refusal, withdrawing its write, when it folds a sqlite write", async () => {
          const cell = await syncedCell(space, "completion-sqlite");
          const tx = completion();
          cell.withTx(tx).set({ n: 1 });
          tx.tx.recordSqliteWrite?.(space, {
            op: "sqlite",
            db,
            sql: "INSERT INTO notes (body) VALUES (?)",
            params: ["refused"],
          });

          const refused = await tx.commit().settled;
          await runtime.storageManager.synced();

          expect(refused.error?.message).toContain(
            "must not fold sqlite ops",
          );
          expect(cell.get()).toBeUndefined();
          expect(await stored(space, cell)).toBeUndefined();
        });

        it("returns the store's rejection, withdrawing its write, when the store refuses its commit", async () => {
          const cell = await syncedCell(space, "completion-rejected");
          const tx = completion();
          cell.withTx(tx).set({ n: 1 });
          refuseNextCommit = "the store said no";

          const refused = await tx.commit().settled;
          await runtime.storageManager.synced();

          expect(refused.error?.message).toBe(
            "effect completion commit rejected: the store said no",
          );
          expect(cell.get()).toBeUndefined();
          expect(await stored(space, cell)).toBeUndefined();
        });
      });

      describe("a transaction stamped `directCommit`", () => {
        /** A bookkeeping transaction stamped to commit on its own. */
        const direct = (
          tx: IExtendedStorageTransaction = runtime.edit(),
        ): IExtendedStorageTransaction => {
          runtime.stampServerRun(tx, {
            actionId: "test/direct",
            kind: "bookkeeping",
            directCommit: true,
          });
          return tx;
        };

        it("commits its write to the store, and to the replica, without a local rollback", async () => {
          const cell = await syncedCell(space, "direct-commits");
          const rollbacks = warnings("direct-commit-local-rollback");
          const tx = direct();
          cell.withTx(tx).set({ n: 1 });
          runtime.prepareTxForCommit(tx);

          expect((await tx.commit().settled).error).toBeUndefined();
          expect(await stored(space, cell)).toEqual({ n: 1 });
          expect(cell.get()).toEqual({ n: 1 });
          expect(warnings("direct-commit-local-rollback")).toBe(rollbacks);
        });

        it("returns a refusal naming the park when the tenure parks before the seal is taken up", async () => {
          const cell = await syncedCell(space, "direct-parked");
          const tx = direct();
          cell.withTx(tx).set({ n: 1 });

          const sealing = serving.seal(tx);
          const parking = serving.park("test-park");
          const refused = await sealing;
          await parking;

          expect(refused.error?.message).toBe(
            "direct commit of test/direct arrived while the space is parked",
          );
          expect(await stored(space, cell)).toBeUndefined();
        });

        it("returns a refusal for a transaction whose storage cannot seal", async () => {
          const refused = await serving.seal(
            direct(unsealable(runtime.edit())),
          );

          expect(refused.error?.message).toBe(
            "storage transaction does not support sealing",
          );
          expect(refused.error).toMatchObject({
            reason: expect.objectContaining({
              message: "direct-commit-refused",
            }),
          });
        });

        it("returns a refusal when the serving space's replica cannot build the store's commit", async () => {
          const cell = await syncedCell(space, "direct-no-store-commit");
          const tx = direct();
          cell.withTx(tx).set({ n: 1 });
          runtime.prepareTxForCommit(tx);
          const replica = replicaOf(space);
          replica.storeCommitOf = undefined;
          let refused;
          try {
            refused = await tx.commit().settled;
          } finally {
            delete replica.storeCommitOf;
          }

          expect(refused.error?.message).toBe(
            `space replica for ${space} does not support sealing`,
          );
          expect(await stored(space, cell)).toBeUndefined();
        });

        it("returns a refusal when its transaction can no longer read the documents it guards", async () => {
          const cell = await syncedCell(space, "direct-unguarded");
          const tx = direct();
          cell.withTx(tx).set({ n: 1 });
          tx.tx.abort?.();

          const refused = await serving.seal(tx);

          expect(refused.error?.message).toContain(
            "direct commit could not guard",
          );
          expect(await stored(space, cell)).toBeUndefined();
        });

        it("returns a refusal when it folds a sqlite write", async () => {
          const cell = await syncedCell(space, "direct-sqlite");
          const tx = direct();
          cell.withTx(tx).set({ n: 1 });
          tx.tx.recordSqliteWrite?.(space, {
            op: "sqlite",
            db,
            sql: "INSERT INTO notes (body) VALUES (?)",
            params: ["refused"],
          });
          runtime.prepareTxForCommit(tx);

          const refused = await tx.commit().settled;

          expect(refused.error?.message).toBe(
            "direct commit of test/direct folds sqlite ops; those ride " +
              "scheduler runs' wave batches",
          );
          expect(await stored(space, cell)).toBeUndefined();
        });

        it("reports the commit and warns when the replica rolls back the write the store took", async () => {
          const cell = await syncedCell(space, "direct-rolled-back");
          const rollbacks = warnings("direct-commit-local-rollback");
          const tx = direct();
          cell.withTx(tx).set({ n: 1 });
          runtime.prepareTxForCommit(tx);
          // A replica whose local apply of the store's verdict rejects.
          const replica = replicaOf(space);
          const seal = replica.sealNative!.bind(replica);
          const rejection = {
            name: "StoreError" as const,
            message: "local apply refused",
            cause: { name: "Test", message: "local apply refused" },
          };
          replica.sealNative = (...args) => ({
            ...seal(...args),
            settled: Promise.resolve({ error: rejection }),
          });
          let committed;
          try {
            committed = await tx.commit().settled;
          } finally {
            delete replica.sealNative;
          }

          expect(committed.error).toBeUndefined();
          expect(await stored(space, cell)).toEqual({ n: 1 });
          expect(warnings("direct-commit-local-rollback")).toBe(
            rollbacks + 1,
          );
        });
      });
    });
  });
});
