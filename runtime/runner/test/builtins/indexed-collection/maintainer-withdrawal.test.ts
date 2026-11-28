/**
 * Drives an `IndexedCollectionMaintainer` on a runtime that seals every
 * transaction into a wave of its own, where the test decides whether each
 * wave commits or is abandoned, so that a maintenance transaction can be
 * withdrawn after it ended. The collections are seeded beforehand by a
 * runtime that commits to the same memory server directly.
 */

import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { defineIndexedCollections } from "../../../src/builtins/indexed-collection/definition.ts";
import { maintenanceRevisionCell } from "../../../src/builtins/indexed-collection/maintenance.ts";
import { CellImpl } from "../../../src/cell.ts";
import { EngineWaveCommitSink } from "../../../src/executor/engine-wave-sink.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
} from "../../../src/executor/wave.ts";
import { Runtime } from "../../../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../../src/storage/v2-emulate.ts";
import { captureLogs } from "../../support/captured-logs.ts";
import { newSharedServer } from "../../memory-v2-test-utils.ts";

/** What becomes of the wave the `n`th sealed transaction went into. */
type Policy = (n: number) => "commit" | "abandon";

describe("IndexedCollectionMaintainer", () => {
  let signer: Identity;
  let space: MemorySpace;
  let server: ReturnType<typeof newSharedServer>;
  let managers: EmulatedStorageManager[];
  let runtime: Runtime;
  let engine: Engine.Engine;
  let lease: ExecutionLeaseCycle;
  let sink: EngineWaveCommitSink;
  let policy: Policy;
  let seals: number;
  let ended: Promise<void>[];
  let waiters: { count: number; resolve: () => void }[];

  /** The databases of the two collections the seeding declares. */
  let topics: SqliteDbRef;
  let empty: SqliteDbRef;

  beforeEach(async () => {
    signer = await Identity.fromPassphrase(
      `indexed-collection-withdrawal-${crypto.randomUUID()}`,
    );
    space = signer.did();
    server = newSharedServer();
    managers = [];
    policy = () => "commit";
    seals = 0;
    ended = [];
    waiters = [];
    await seed();
    const manager = connect();
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
      indexedCollectionMaintenance: "own",
    });
    engine = await server.engineForSpace(space);
    lease = new ExecutionLeaseCycle({
      leases: engine.executionLeases,
      space,
      holder: executionLeaseHolder(`service:${space}`),
    });
    expect(await lease.acquire()).toBe(true);
    sink = new EngineWaveCommitSink({
      engineFor: () => engine,
      sessionId: executionLeaseHolder(`service:${space}`),
      sqliteAttachmentsFor: (target, operations, scopeKeys) =>
        server.attachWaveCommitSqliteDbs(engine, target, operations, scopeKeys),
    });
  });

  afterEach(async () => {
    runtime.clearSealDestination();
    await Promise.all(ended);
    await lease.release();
    await runtime.dispose();
    for (const manager of managers) await manager.close();
    await server.close();
  });

  function connect(): EmulatedStorageManager {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    managers.push(manager);
    return manager;
  }

  /**
   * Declares a collection of topics holding the topic `a`, whose title was
   * renamed to `renamed` after its rows were written, and a collection with
   * no member whose declaration no runtime has recorded.
   */
  async function seed(): Promise<void> {
    const seeder = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: connect(),
      indexedCollectionMaintenance: "own",
    });
    const commit = async (fn: (tx: IExtendedStorageTransaction) => void) => {
      const tx = seeder.edit();
      fn(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await seeder.settled();
    };
    const declare = (cause: string) => {
      const { tables, index } = defineIndexedCollections({
        topics: { columns: { title: "text" } },
      });
      let db: SqliteDbRef | undefined;
      return commit((tx) => {
        const handle = seeder.getCell(space, cause, undefined, tx);
        db = {
          id: handle.getAsNormalizedFullLink().id.replace(/^of:/, ""),
          tables,
        };
        handle.setRawUntyped({ ...db, index });
      }).then(() => db!);
    };
    const topic = (tx?: IExtendedStorageTransaction) =>
      seeder.getCell<{ title: string }>(space, "topic-a", undefined, tx);
    topics = await declare("topics");
    await commit((tx) => {
      topic(tx).set({ title: "a" });
      new CellImpl(
        seeder,
        tx,
        seeder.getCell(space, "topics").getAsNormalizedFullLink(),
        false,
        undefined,
        "sqlite",
      ).add("topics", topic(tx));
    });
    seeder.indexedCollections.dispose();
    await commit((tx) => topic(tx).key("title").set("renamed"));
    empty = await declare("empty");
    await seeder.dispose({ closeStorage: false });
  }

  /** Has every transaction from now on seal into a wave of its own. */
  function sealIntoWaves(): void {
    runtime.installSealDestination({
      seal: async (tx) => {
        const wave = new WaveAccumulator({
          space,
          basisSeq: Engine.serverSeq(engine),
          lease,
          foreignWrites: "accept",
          foreignWriteGrant: () => true,
          scopeKeyIdentity: { principal: signer.did(), sessionId: "waves" },
          replicaFor: (target) => runtime.storageManager.open(target).replica,
        });
        const result = await wave.seal(tx);
        const n = ++seals;
        ended.push(
          end(wave, policy(n)).then(() => {
            for (const waiter of waiters) {
              if (waiter.count <= n) waiter.resolve();
            }
          }),
        );
        return result;
      },
    }, {
      runStamper: (tx, info) =>
        stampWaveRunContext(tx, { actionId: info.actionId, kind: info.kind }),
    });
  }

  async function end(
    wave: WaveAccumulator,
    verdict: "commit" | "abandon",
  ): Promise<void> {
    if (verdict === "abandon") {
      wave.abandon("withdrawn by the test");
    } else {
      await wave.commitWave(sink);
    }
    await wave.settled();
  }

  /** Settles once the wave of the `count`th sealed transaction has ended. */
  function wavesEnded(count: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push({ count, resolve });
    if (seals >= count) void Promise.all(ended).then(() => resolve());
    return promise;
  }

  function register(db: SqliteDbRef, cause: string): void {
    runtime.indexedCollections.register(
      runtime.getCell(space, cause).getAsNormalizedFullLink(),
      db.id,
    );
  }

  async function rows(
    db: SqliteDbRef,
    sql: string,
  ): Promise<Record<string, unknown>[]> {
    const result = await runtime.storageManager.open(space).sqliteQuery!(
      db,
      sql,
    );
    return result.rows as Record<string, unknown>[];
  }

  function topicDoc(): string {
    return runtime.getCell(space, "topic-a").getAsNormalizedFullLink().id;
  }

  /** Has the topics collection adopted, with its declaration already up. */
  async function adoptTopics(): Promise<void> {
    await runtime.getCell(space, "topics").sync();
    await maintenanceRevisionCell(runtime, space, topics.id).sync();
    register(topics, "topics");
    await runtime.settled();
  }

  describe("a withdrawn re-read of members", () => {
    it("is made again, and lands once a wave accepts it", async () => {
      await adoptTopics();
      sealIntoWaves();
      policy = (n) => n === 1 ? "abandon" : "commit";

      runtime.indexedCollections.noteWrites(space, [topicDoc()]);
      await wavesEnded(2);
      await runtime.settled();

      expect(seals).toBe(2);
      expect(await rows(topics, "SELECT title FROM topics")).toEqual([
        { title: "renamed" },
      ]);
    });

    it("waits for the next write to the space once it was withdrawn more than three times in a row", async () => {
      using logs = captureLogs("indexed-collection");
      await adoptTopics();
      sealIntoWaves();
      policy = (n) => n <= 4 ? "abandon" : "commit";

      runtime.indexedCollections.noteWrites(space, [topicDoc()]);
      await logs.first("maintenance-withdrawn");
      await wavesEnded(4);
      await runtime.settled();
      expect(seals).toBe(4);
      expect(await rows(topics, "SELECT title FROM topics")).toEqual([
        { title: "a" },
      ]);

      runtime.indexedCollections.noteWrites(space, ["of:unrelated"]);
      await wavesEnded(5);
      await runtime.settled();
      expect(seals).toBe(5);
      expect(logs.messagesOf("maintenance-withdrawn")).toEqual([
        [runtime.getCell(space, "topics").getAsNormalizedFullLink().id],
      ]);
      expect(await rows(topics, "SELECT title FROM topics")).toEqual([
        { title: "renamed" },
      ]);
    });
  });

  describe("a withdrawn record of the declaration", () => {
    it("is made again, and lands once a wave accepts it", async () => {
      await runtime.getCell(space, "empty").sync();
      sealIntoWaves();
      policy = (n) => n === 1 ? "abandon" : "commit";

      register(empty, "empty");
      await wavesEnded(3);
      await runtime.settled();

      expect(seals).toBe(3);
      expect(
        await rows(empty, "SELECT key FROM collection_meta ORDER BY key"),
      ).toEqual([{ key: "declaration" }, { key: "migrating" }]);
    });

    it("is made again at most three times in a row", async () => {
      using logs = captureLogs("indexed-collection");
      await runtime.getCell(space, "empty").sync();
      sealIntoWaves();
      policy = () => "abandon";

      register(empty, "empty");
      await wavesEnded(5);
      await runtime.settled();

      expect(seals).toBe(5);
      expect(logs.messagesOf("maintenance-withdrawn")).toHaveLength(2);
      expect(await rows(empty, "SELECT key FROM collection_meta")).toEqual(
        [],
      );
    });

    it("is neither reported nor made again once the maintainer is disposed", async () => {
      using logs = captureLogs("indexed-collection");
      await runtime.getCell(space, "empty").sync();
      sealIntoWaves();
      policy = (n) => {
        if (n === 4) runtime.indexedCollections.dispose();
        return "abandon";
      };

      register(empty, "empty");
      await wavesEnded(4);
      await runtime.settled();

      expect(seals).toBe(4);
      expect(logs.messagesOf("maintenance-withdrawn")).toEqual([]);
      expect(await rows(empty, "SELECT key FROM collection_meta")).toEqual(
        [],
      );
    });
  });
});
