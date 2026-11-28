/**
 * Drives an `IndexedCollectionMaintainer` over emulated storage, through the
 * runtime that owns it, at the points where what it is handed is not what a
 * healthy collection hands it: a check of the declaration that fails, a
 * handle that declares no collection, a member that cannot be read, a
 * registry that lists something unreadable, and a maintainer disposed while
 * it works. Where a case needs the storage provider to answer in a given
 * order, it replaces one method of the provider, as the reply the maintainer
 * waits for is what decides the order.
 */

import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  defineIndexedCollections,
  type IndexedCollectionOptions,
} from "../../../src/builtins/indexed-collection/definition.ts";
import type { IndexedCollectionMaintenance } from "../../../src/builtins/indexed-collection/maintainer.ts";
import {
  memberKeyOf,
  type MemberRows,
} from "../../../src/builtins/indexed-collection/maintenance.ts";
import {
  indexedCollectionRegistry,
  indexedCollectionRegistryId,
} from "../../../src/builtins/indexed-collection/registry.ts";
import { type Cell, CellImpl, createCell } from "../../../src/cell.ts";
import { Runtime } from "../../../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../../../src/storage/interface.ts";
import { captureLogs } from "../../support/captured-logs.ts";

type Topic = { title: string };

type Provider = ReturnType<
  ReturnType<typeof StorageManager.emulate>["open"]
>;

const TITLES = "SELECT title FROM topics ORDER BY title";
const DECLARATION = "SELECT key FROM collection_meta WHERE key = 'declaration'";

describe("IndexedCollectionMaintainer", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let space: MemorySpace;
  let db: SqliteDbRef;
  let errors: unknown[];

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase(
      `indexed-collection-maintainer-${crypto.randomUUID()}`,
    );
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    start("own");
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Starts a runtime that maintains what `mode` names, over the storage. */
  function start(mode: IndexedCollectionMaintenance): void {
    errors = [];
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      indexedCollectionMaintenance: mode,
    });
    runtime.scheduler.onError((error) => errors.push(error));
  }

  /** Replaces the runtime with one that maintains what `mode` names. */
  async function restart(mode: IndexedCollectionMaintenance): Promise<void> {
    await runtime.settled();
    await runtime.dispose({ closeStorage: false });
    start(mode);
  }

  function provider(): Provider {
    return storageManager.open(space);
  }

  async function commit(
    fn: (tx: IExtendedStorageTransaction) => void,
  ): Promise<void> {
    const tx = runtime.edit();
    fn(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.settled();
  }

  function handle(tx?: IExtendedStorageTransaction): Cell<unknown> {
    return runtime.getCell(space, "collection", undefined, tx);
  }

  /** Writes the handle of a collection of topics declared by `options`. */
  function declare(options: IndexedCollectionOptions): Promise<void> {
    const { tables, index } = defineIndexedCollections({ topics: options });
    return commit((tx) => {
      const cell = handle(tx);
      db = {
        id: cell.getAsNormalizedFullLink().id.replace(/^of:/, ""),
        tables,
      };
      // A handle declared again keeps the write revision it had.
      const { rev } = (cell.getRaw() ?? {}) as { rev?: number };
      cell.setRawUntyped({ ...db, index, ...(rev !== undefined && { rev }) });
    });
  }

  function topic(name: string, tx?: IExtendedStorageTransaction): Cell<Topic> {
    return runtime.getCell<Topic>(space, `topic-${name}`, undefined, tx);
  }

  function addTopic(name: string): Promise<void> {
    return commit((tx) => {
      const cell = topic(name, tx);
      cell.set({ title: name });
      new CellImpl(
        runtime,
        tx,
        handle().getAsNormalizedFullLink(),
        false,
        undefined,
        "sqlite",
      ).add("topics", cell);
    });
  }

  function rename(name: string, title: string): Promise<void> {
    return commit((tx) => topic(name, tx).key("title").set(title));
  }

  async function rows(sql: string): Promise<Record<string, unknown>[]> {
    const result = await provider().sqliteQuery!(db, sql);
    return result.rows as Record<string, unknown>[];
  }

  /** Has the provider refuse the next query whose text includes `text`. */
  function refuseNextQuery(text: string): void {
    const query = provider().sqliteQuery!.bind(provider());
    let refused = false;
    provider().sqliteQuery = (ref, sql, ...rest) => {
      if (refused || !sql.includes(text)) return query(ref, sql, ...rest);
      refused = true;
      return Promise.reject(new Error("the database is unavailable"));
    };
  }

  /**
   * Holds the reply to the next query whose text includes `text` until the
   * returned `release()` is called; `asked` settles once it has been asked.
   */
  function holdNextQuery(text: string) {
    const query = provider().sqliteQuery!.bind(provider());
    const asked = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let held = false;
    provider().sqliteQuery = async (ref, sql, ...rest) => {
      const reply = await query(ref, sql, ...rest);
      if (!held && sql.includes(text)) {
        held = true;
        asked.resolve();
        await released.promise;
      }
      return reply;
    };
    return { asked: asked.promise, release: () => released.resolve() };
  }

  describe("instance members", () => {
    describe("register()", () => {
      it("queries nothing for a handle that declares no collection", async () => {
        using logs = captureLogs("indexed-collection");
        await commit((tx) => handle(tx).setRaw({ id: "plain" }));
        const query = provider().sqliteQuery!.bind(provider());
        const asked: string[] = [];
        provider().sqliteQuery = (ref, sql, ...rest) => {
          asked.push(sql);
          return query(ref, sql, ...rest);
        };

        runtime.indexedCollections.register(
          handle().getAsNormalizedFullLink(),
          "plain",
        );
        runtime.indexedCollections.noteWrites(space, [
          topic("a").getAsNormalizedFullLink().id,
        ]);
        await runtime.settled();
        expect(asked).toEqual([]);
        expect(logs.logs).toEqual([]);

        await declare({ columns: { title: "text" } });
        runtime.indexedCollections.register(
          handle().getAsNormalizedFullLink(),
          db.id,
        );
        await runtime.settled();
        expect(asked.some((sql) => sql.includes("collection_meta"))).toBe(
          true,
        );
      });

      it("keeps the members current after the check of the declaration fails", async () => {
        using logs = captureLogs("indexed-collection");
        await declare({ columns: { title: "text" } });
        refuseNextQuery("collection_meta");
        await addTopic("a");
        await rename("a", "renamed");

        expect(logs.messagesOf("reconcile-failed")).toEqual([
          [handle().getAsNormalizedFullLink().id, expect.any(Error)],
        ]);
        expect(await rows(TITLES)).toEqual([{ title: "renamed" }]);
        expect(await rows(DECLARATION)).toEqual([]);
      });
    });

    describe("noteAdded()", () => {
      it("does nothing for a collection the maintainer does not hold", async () => {
        using logs = captureLogs("indexed-collection");
        await declare({ columns: { title: "text" } });
        await addTopic("a");
        const query = provider().sqliteQuery!.bind(provider());
        let asked = 0;
        provider().sqliteQuery = (...args) => {
          asked++;
          return query(...args);
        };

        runtime.indexedCollections.noteAdded(space, "elsewhere", {
          kind: "topics",
          member: memberKeyOf(topic("a")),
          values: ["stale"],
          relations: [],
          deps: [],
        });
        await runtime.settled();
        expect(asked).toBe(0);

        runtime.indexedCollections.noteAdded(space, db.id, {
          kind: "topics",
          member: memberKeyOf(topic("a")),
          values: ["stale"],
          relations: [],
          deps: [],
        });
        await runtime.settled();
        expect(asked).toBeGreaterThan(0);
        expect(logs.logs).toEqual([]);
      });

      it("owes a member it could not re-read to the drain the next write starts", async () => {
        using logs = captureLogs("indexed-collection");
        await declare({ columns: { title: "text" } });
        await addTopic("a");
        const unreadable: MemberRows = {
          kind: "topics",
          member: "not a reference",
          values: [null],
          relations: [],
          deps: [],
        };

        runtime.indexedCollections.noteAdded(space, db.id, unreadable);
        await runtime.settled();
        expect(logs.messagesOf("drain-failed")).toEqual([
          [handle().getAsNormalizedFullLink().id, expect.any(TypeError)],
        ]);

        await rename("a", "renamed");
        expect(logs.messagesOf("drain-failed")).toEqual([
          [handle().getAsNormalizedFullLink().id, expect.any(TypeError)],
          [handle().getAsNormalizedFullLink().id, expect.any(TypeError)],
        ]);
      });

      it("skips a member of a kind the declaration does not have", async () => {
        using logs = captureLogs("indexed-collection");
        await declare({ columns: { title: "text" } });
        await addTopic("a");

        runtime.indexedCollections.noteAdded(space, db.id, {
          kind: "authors",
          member: memberKeyOf(topic("a")),
          values: ["stale"],
          relations: [],
          deps: [],
        });
        await runtime.settled();

        expect(logs.logs).toEqual([]);
        expect(errors).toEqual([]);
        expect(await rows(TITLES)).toEqual([{ title: "a" }]);
      });
    });

    describe("noteWrites()", () => {
      it("keeps the members current after the check of a new declaration fails", async () => {
        using logs = captureLogs("indexed-collection");
        await declare({ columns: { title: "text" } });
        await addTopic("a");
        refuseNextQuery("collection_meta");
        await declare({
          columns: { title: { type: "text", path: ["title"] } },
        });
        await rename("a", "renamed");

        expect(logs.messagesOf("reconcile-failed")).toEqual([
          [handle().getAsNormalizedFullLink().id, expect.any(Error)],
        ]);
        expect(await rows(TITLES)).toEqual([{ title: "renamed" }]);
      });

      it("writes the other members of a batch when one cannot be read", async () => {
        using logs = captureLogs("indexed-collection");
        await declare({ columns: { title: "text" } });
        await addTopic("a");
        await addTopic("b");
        await commit((tx) => {
          const own = createCell<string>(
            runtime,
            {
              ...runtime.getCell(space, "own-title").getAsNormalizedFullLink(),
              scope: "user",
            },
            tx,
          );
          own.set("mine");
          topic("a", tx).setRawUntyped({ title: own.getAsLink() });
          topic("b", tx).key("title").set("renamed");
        });

        expect(logs.messagesOf("member-unreadable")).toEqual([
          [memberKeyOf(topic("a")), expect.any(TypeError)],
        ]);
        expect(await rows(TITLES)).toEqual([
          { title: "a" },
          { title: "renamed" },
        ]);
      });

      it("writes nothing once the handle stops declaring the collection", async () => {
        using logs = captureLogs("indexed-collection");
        await declare({ columns: { title: "text" } });
        await addTopic("a");
        const lookup = holdNextQuery(":docs");
        const renamed = runtime.edit();
        topic("a", renamed).key("title").set("renamed");
        expect((await renamed.commit().settled).error).toBeUndefined();
        await lookup.asked;
        const plain = runtime.edit();
        handle(plain).setRaw({ id: db.id, tables: db.tables });
        expect((await plain.commit().settled).error).toBeUndefined();
        lookup.release();
        await runtime.settled();
        await rename("a", "again");

        expect(errors).toEqual([]);
        expect(logs.logs).toEqual([]);
        expect(await rows(TITLES)).toEqual([{ title: "a" }]);
      });
    });

    describe("dispose()", () => {
      it("records no declaration once disposed while it re-reads every member", async () => {
        await restart("none");
        await declare({ columns: { title: "text" } });
        await addTopic("a");
        await restart("own");
        const query = provider().sqliteQuery!.bind(provider());
        provider().sqliteQuery = async (ref, sql, ...rest) => {
          const reply = await query(ref, sql, ...rest);
          if (sql.startsWith("WITH") && !sql.includes(":docs")) {
            runtime.indexedCollections.dispose();
          }
          return reply;
        };
        await handle().sync();

        runtime.indexedCollections.register(
          handle().getAsNormalizedFullLink(),
          db.id,
        );
        await runtime.settled();

        expect(await rows("SELECT key FROM collection_meta")).toEqual([
          { key: "migrating" },
        ]);
        expect(errors).toEqual([]);
      });

      it("records nothing for a declaration that changed before it was disposed", async () => {
        using logs = captureLogs("indexed-collection");
        await restart("none");
        await declare({ columns: { title: "text" } });
        await addTopic("a");
        await restart("own");
        await handle().sync();
        const query = provider().sqliteQuery!.bind(provider());
        const asked: string[] = [];
        provider().sqliteQuery = (ref, sql, ...rest) => {
          asked.push(sql);
          return query(ref, sql, ...rest);
        };
        const check = holdNextQuery("collection_meta");
        runtime.indexedCollections.register(
          handle().getAsNormalizedFullLink(),
          db.id,
        );
        await check.asked;
        const { tables, index } = defineIndexedCollections({
          topics: { columns: { title: "text", rank: "integer" } },
        });
        const redeclared = runtime.edit();
        handle(redeclared).setRawUntyped({ ...db, tables, index, rev: 1 });
        expect((await redeclared.commit().settled).error).toBeUndefined();

        runtime.indexedCollections.dispose();
        check.release();
        await runtime.settled();

        // The check of the new declaration, queued behind the held one, asks
        // nothing once disposed.
        expect(asked.filter((sql) => sql.includes("collection_meta")))
          .toHaveLength(1);
        expect(await rows("SELECT key FROM collection_meta")).toEqual([]);
        expect(logs.logs).toEqual([]);
      });
    });
  });

  describe("a runtime that maintains listed collections", () => {
    /** Writes `entries` into the space's registry. */
    function list(entries: Record<string, string | null>): Promise<void> {
      return commit((tx) => {
        const registry = indexedCollectionRegistry(runtime, space, tx);
        for (const [id, link] of Object.entries(entries)) {
          registry.key(id).setRaw(link);
        }
      });
    }

    /** Waits for the latest read of the registry and what it started. */
    async function registryRead(): Promise<void> {
      await runtime.indexedCollections.accessForTestingOnly.spaces.get(space)
        ?.loaded;
      await runtime.settled();
    }

    it("adopts a listed collection beside entries it cannot read", async () => {
      using logs = captureLogs("indexed-collection");
      await declare({ columns: { title: "text" } });
      await addTopic("a");
      await restart("listed");

      await list({ unreadable: "not a link", empty: null });
      await registryRead();
      await rename("a", "renamed");

      expect(logs.messagesOf("registry-entry-unreadable")).toEqual([
        [space, "unreadable", expect.any(TypeError)],
      ]);
      expect(await rows(TITLES)).toEqual([{ title: "renamed" }]);
    });

    it("reads the registry again on the write after a read that failed", async () => {
      using logs = captureLogs("indexed-collection");
      await declare({ columns: { title: "text" } });
      await addTopic("a");
      await restart("listed");
      const exists = provider().entityIdExists!.bind(provider());
      let asked = 0;
      provider().entityIdExists = (id) =>
        ++asked === 1
          ? Promise.reject(new Error("the store is unavailable"))
          : exists(id);

      runtime.indexedCollections.noteWrites(space, ["of:unrelated"]);
      await registryRead();
      expect(logs.messagesOf("registry-load-failed")).toEqual([
        [space, expect.any(Error)],
      ]);
      await rename("a", "renamed");
      await registryRead();

      expect(asked).toBe(2);
      expect(await rows(TITLES)).toEqual([{ title: "renamed" }]);
    });

    it("finds nothing listed in a registry that holds no record", async () => {
      using logs = captureLogs("indexed-collection");
      await restart("listed");
      const exists = provider().entityIdExists!.bind(provider());
      let asked = 0;
      provider().entityIdExists = (id) => {
        asked++;
        return exists(id);
      };

      await commit((tx) =>
        indexedCollectionRegistry(runtime, space, tx).setRawUntyped("junk")
      );
      await registryRead();
      await commit((tx) => topic("a", tx).set({ title: "a" }));

      expect(logs.logs).toEqual([]);
      expect(asked).toBe(1);
    });

    it("holds a write heard while the registry is read again for that read", async () => {
      // The first read is answered as though the registry did not exist yet,
      // and the read a write to the registry starts is held until the write
      // to the member has been heard. Only that second read lists the
      // collection, so the member is re-read only if the write waited for it.

      await declare({ columns: { title: "text" } });
      await addTopic("a");
      await restart("listed");
      const exists = provider().entityIdExists!.bind(provider());
      const secondAsked = Promise.withResolvers<void>();
      const releaseSecond = Promise.withResolvers<void>();
      let asked = 0;
      provider().entityIdExists = async (id) => {
        asked++;
        if (asked === 1) return false;
        if (asked === 2) {
          secondAsked.resolve();
          await releaseSecond.promise;
        }
        return exists(id);
      };

      runtime.indexedCollections.noteWrites(space, ["of:unrelated"]);
      runtime.indexedCollections.noteWrites(space, [
        indexedCollectionRegistryId(),
      ]);
      await secondAsked.promise;
      const renamed = runtime.edit();
      topic("a", renamed).key("title").set("renamed");
      expect((await renamed.commit().settled).error).toBeUndefined();
      releaseSecond.resolve();
      await registryRead();

      expect(await rows(TITLES)).toEqual([{ title: "renamed" }]);
    });
  });
});
