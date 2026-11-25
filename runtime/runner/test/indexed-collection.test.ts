/**
 * Drives an indexed collection from a single runtime over emulated storage:
 * the handle is minted directly, members are added through the cell method a
 * handler would call, and rows are read back with the storage provider's own
 * query, so every assertion is about what the database holds.
 */

import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import {
  defineIndexedCollections,
  type IndexedCollectionDefinition,
  indexedCollectionDescriptorOf,
  type IndexedCollectionOptions,
  type IndexedKindDescriptor,
  indexedKindOf,
} from "../src/builtins/indexed-collection/definition.ts";
import {
  maintenanceRevisionCell,
  memberKeyOf,
  type MemberRows,
  projectMember,
} from "../src/builtins/indexed-collection/maintenance.ts";
import { type Cell, createCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { toMemorySpaceAddress } from "../src/link-types.ts";
import type {
  IExtendedStorageTransaction,
  IReadActivity,
} from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

type Topic = { title: string; body: string; rank: number; mentions: unknown[] };

type Collection = {
  add(kind: string, member: unknown): void;
  remove(kind: string, member: unknown): void;
};

describe("indexed-collection", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let space: `did:${string}:${string}`;
  let db: SqliteDbRef;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase(
      `indexed-collection-${crypto.randomUUID()}`,
    );
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Commits `fn`, then waits for the collection to follow the commit. */
  async function commit<T>(
    fn: (tx: IExtendedStorageTransaction) => T,
  ): Promise<T> {
    const tx = runtime.edit();
    const result = fn(tx);
    const { error } = await tx.commit().settled;
    expect(error).toBeUndefined();
    await runtime.settled();
    return result;
  }

  /** Mints the handle of a collection declared by `options`. */
  function declare(options: IndexedCollectionOptions): Promise<void> {
    return declareAs(defineIndexedCollections({ topics: options }));
  }

  /** Mints, or declares again, the handle of the collection `definition`. */
  async function declareAs(
    { tables, index }: IndexedCollectionDefinition,
  ): Promise<void> {
    await commit((tx) => {
      const handle = runtime.getCell(space, "collection", undefined, tx);
      const id = handle.getAsNormalizedFullLink().id.replace(/^of:/, "");
      db = { id, tables };
      // A handle declared again keeps the write revision it had.
      const { rev } = (handle.getRaw() ?? {}) as { rev?: number };
      handle.setRawUntyped({ ...db, index, ...(rev !== undefined && { rev }) });
    });
  }

  function collection(tx: IExtendedStorageTransaction): Collection {
    return createCell(
      runtime,
      runtime.getCell(space, "collection").getAsNormalizedFullLink(),
      tx,
      false,
      "sqlite",
    ) as unknown as Collection;
  }

  function topic(
    name: string,
    tx?: IExtendedStorageTransaction,
  ): Cell<Topic> {
    return runtime.getCell<Topic>(space, `topic-${name}`, undefined, tx);
  }

  async function addTopic(
    name: string,
    value: Partial<Topic> = {},
  ): Promise<void> {
    await commit((tx) => {
      const cell = topic(name, tx);
      cell.set({ title: name, body: "", rank: 0, mentions: [], ...value });
      collection(tx).add("topics", cell);
    });
  }

  async function rows(sql: string): Promise<Record<string, unknown>[]> {
    const result = await storageManager.open(space).sqliteQuery!(db, sql);
    return result.rows as Record<string, unknown>[];
  }

  /** How many writes maintenance has made to the collection. */
  async function rev(): Promise<number> {
    await runtime.idle();
    const revision = maintenanceRevisionCell(runtime, space, db.id).getRaw();
    return revision === undefined ? 0 : Number(revision.split(":")[1]);
  }

  describe("add()", () => {
    it("mirrors the declared columns of the member", async () => {
      await declare({ columns: { title: "text", rank: "integer" } });
      await addTopic("a", { rank: 3 });

      expect(await rows("SELECT title, rank FROM topics")).toEqual([
        { title: "a", rank: 3 },
      ]);
    });

    it("stores the member under its cell reference", async () => {
      await declare({ columns: { title: "text" } });
      await addTopic("a");

      expect(await rows("SELECT member_cf_link FROM topics")).toEqual([
        { member_cf_link: memberKeyOf(topic("a")) },
      ]);
    });

    it("refreshes the rows of a member added twice", async () => {
      await declare({ columns: { title: "text" } });
      await addTopic("a");
      await addTopic("a", { title: "again" });

      expect(await rows("SELECT title FROM topics")).toEqual([
        { title: "again" },
      ]);
    });

    it("throws on a cell of another space", async () => {
      await declare({ columns: { title: "text" } });
      const elsewhere = await Identity.fromPassphrase(
        `indexed-collection-elsewhere-${crypto.randomUUID()}`,
      );
      const tx = runtime.edit();
      const foreign = runtime.getCell(elsewhere.did(), "far", undefined, tx);

      expect(() => collection(tx).add("topics", foreign)).toThrow(
        "its own space",
      );
      tx.abort();
      await runtime.idle();
    });

    it("throws on a database that is not an indexed collection", async () => {
      const tx = runtime.edit();
      const handle = runtime.getCell(space, "plain", undefined, tx);
      handle.setRaw({ id: "plain" });
      const plain = createCell(
        runtime,
        handle.getAsNormalizedFullLink(),
        tx,
        false,
        "sqlite",
      ) as unknown as Collection;

      expect(() => plain.add("topics", topic("a", tx))).toThrow(
        "indexed collection",
      );
      tx.abort();
      await runtime.idle();
    });
  });

  describe("relations", () => {
    const mentioning = "SELECT m.title FROM topics_mentions e JOIN topics m " +
      "ON m.member_cf_link = e.source_cf_link WHERE e.target_cf_link = " +
      "(SELECT member_cf_link FROM topics WHERE title = 'target') " +
      "ORDER BY m.title";

    beforeEach(async () => {
      await declare({ columns: { title: "text" }, relations: ["mentions"] });
      await addTopic("target");
    });

    it("stores one row per reference a member holds", async () => {
      await addTopic("a", { mentions: [topic("target")] });
      await addTopic("b", { mentions: [topic("target"), topic("a")] });
      await addTopic("c");

      expect(await rows(mentioning)).toEqual([{ title: "a" }, { title: "b" }]);
    });

    it("counts a repeated reference once", async () => {
      await addTopic("a", { mentions: [topic("target"), topic("target")] });

      expect(await rows("SELECT count(*) AS n FROM topics_mentions")).toEqual([
        { n: 1 },
      ]);
    });

    it("follows a reference added to a member after it joined", async () => {
      await addTopic("a");
      await commit((tx) =>
        topic("a", tx).key("mentions").push(topic("target"))
      );

      expect(await rows(mentioning)).toEqual([{ title: "a" }]);
    });

    it("drops a reference removed from a member", async () => {
      await addTopic("a", { mentions: [topic("target")] });
      await commit((tx) => topic("a", tx).key("mentions").set([]));

      expect(await rows(mentioning)).toEqual([]);
    });
  });

  describe("a column read from a nested value", () => {
    beforeEach(async () => {
      await declare({
        columns: {
          title: "text",
          author: { type: "text", path: ["meta", "author", "name"] },
        },
      });
    });

    it("mirrors the value at the path", async () => {
      await commit((tx) => {
        const cell = topic("a", tx);
        cell.setRawUntyped({ title: "a", meta: { author: { name: "Ada" } } });
        collection(tx).add("topics", cell);
      });

      expect(await rows("SELECT title, author FROM topics")).toEqual([
        { title: "a", author: "Ada" },
      ]);
    });

    it("stores `NULL` where the member has nothing at the path", async () => {
      await addTopic("a");

      expect(await rows("SELECT title, author FROM topics")).toEqual([
        { title: "a", author: null },
      ]);
    });

    it("follows the value once a later write supplies it", async () => {
      await addTopic("a");
      await commit((tx) =>
        topic("a", tx).setRawUntyped({
          title: "a",
          meta: { author: { name: "Grace" } },
        })
      );

      expect(await rows("SELECT author FROM topics")).toEqual([
        { author: "Grace" },
      ]);
    });
  });

  describe("a relation holding one reference", () => {
    const parents = "SELECT c.title AS child, p.title AS parent " +
      "FROM topics_parent e JOIN topics c ON c.member_cf_link = e.source_cf_link " +
      "JOIN topics p ON p.member_cf_link = e.target_cf_link ORDER BY c.title";

    beforeEach(async () => {
      await declare({ columns: { title: "text" }, relations: ["parent"] });
      await addTopic("root");
    });

    it("stores one row for the reference", async () => {
      await commit((tx) => {
        const cell = topic("a", tx);
        cell.setRawUntyped({ title: "a", parent: topic("root").getAsLink() });
        collection(tx).add("topics", cell);
      });

      expect(await rows(parents)).toEqual([{ child: "a", parent: "root" }]);
    });

    it("stores one row for a reference to a cell holding nothing", async () => {
      await commit((tx) => {
        const cell = topic("a", tx);
        cell.setRawUntyped({ title: "a", parent: topic("unset").getAsLink() });
        collection(tx).add("topics", cell);
      });

      expect(await rows("SELECT count(*) AS n FROM topics_parent")).toEqual([
        { n: 1 },
      ]);
    });

    it("stores no row for a member holding no reference", async () => {
      await addTopic("a");

      expect(await rows("SELECT count(*) AS n FROM topics_parent")).toEqual([
        { n: 0 },
      ]);
    });
  });

  describe("a collection with several kinds of member", () => {
    const latest = "SELECT t.title AS title, max(c.rank) AS last " +
      "FROM topics t LEFT JOIN comments_topic e " +
      "ON e.target_cf_link = t.member_cf_link " +
      "LEFT JOIN comments c ON c.member_cf_link = e.source_cf_link " +
      "GROUP BY t.member_cf_link ORDER BY t.title";

    beforeEach(async () => {
      await declareAs(defineIndexedCollections({
        topics: { columns: { title: "text" } },
        comments: { columns: { rank: "integer" }, relations: ["topic"] },
      }));
      await commit((tx) => {
        for (const name of ["a", "b"]) {
          const cell = topic(name, tx);
          cell.set({ title: name, body: "", rank: 0, mentions: [] });
          collection(tx).add("topics", cell);
        }
      });
    });

    async function comment(
      name: string,
      on: string,
      rank: number,
    ): Promise<void> {
      await commit((tx) => {
        const cell = topic(name, tx);
        cell.setRawUntyped({ rank, topic: topic(on).getAsLink() });
        collection(tx).add("comments", cell);
      });
    }

    it("joins the members of one kind to those of another in one statement", async () => {
      await comment("first", "a", 3);
      await comment("second", "a", 7);

      expect(await rows(latest)).toEqual([
        { title: "a", last: 7 },
        { title: "b", last: null },
      ]);
    });

    it("follows a write to a member of either kind", async () => {
      await comment("first", "a", 3);
      await commit((tx) => topic("first", tx).key("rank").set(9));
      await commit((tx) => topic("a", tx).key("title").set("renamed"));

      expect(await rows(latest)).toEqual([
        { title: "b", last: null },
        { title: "renamed", last: 9 },
      ]);
    });

    it("removes a member of the kind named", async () => {
      await comment("first", "a", 3);
      await commit((tx) =>
        collection(tx).remove("comments", topic("first", tx))
      );

      expect(await rows(latest)).toEqual([
        { title: "a", last: null },
        { title: "b", last: null },
      ]);
    });

    it("throws on a kind the collection does not declare", async () => {
      const tx = runtime.edit();

      expect(() => collection(tx).add("authors", topic("a", tx))).toThrow(
        "no kind of member",
      );
      tx.abort();
      await runtime.idle();
    });
  });

  describe("a declaration that changes", () => {
    // A collection is brought up to its declaration when a runtime first
    // learns of it, so each case declares again and then starts a second
    // runtime over the same storage.

    async function redeclare(options: IndexedCollectionOptions): Promise<void> {
      await declareAs(defineIndexedCollections({ topics: options }));
      await runtime.dispose({ closeStorage: false });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const handle = runtime.getCell(space, "collection");
      await handle.sync();
      runtime.indexedCollections.register(
        handle.getAsNormalizedFullLink(),
        db.id,
      );
      await runtime.settled();
    }

    it("fills a column the declaration gains, for members never written again", async () => {
      await declare({ columns: { title: "text" } });
      await addTopic("a", { rank: 4 });
      await addTopic("b", { rank: 6 });
      await redeclare({ columns: { title: "text", rank: "integer" } });

      expect(await rows("SELECT title, rank FROM topics ORDER BY title"))
        .toEqual([{ title: "a", rank: 4 }, { title: "b", rank: 6 }]);
    });

    it("fills a relation the declaration gains", async () => {
      await declare({ columns: { title: "text" } });
      await addTopic("target");
      await addTopic("a", { mentions: [topic("target")] });
      await redeclare({ columns: { title: "text" }, relations: ["mentions"] });

      expect(
        await rows(
          "SELECT m.title AS title FROM topics_mentions e JOIN topics m " +
            "ON m.member_cf_link = e.source_cf_link",
        ),
      ).toEqual([{ title: "a" }]);
    });

    it("writes nothing once the tables are up to the declaration", async () => {
      await declare({ columns: { title: "text" } });
      await addTopic("a");
      await redeclare({ columns: { title: "text", rank: "integer" } });
      const before = await rev();
      await redeclare({ columns: { title: "text", rank: "integer" } });

      expect(await rev()).toBe(before);
    });
  });

  describe("projectMember()", () => {
    /** Reads the declaration of the kind `topics` through `tx`. */
    function topics(tx: IExtendedStorageTransaction): IndexedKindDescriptor {
      const declared = indexedCollectionDescriptorOf(
        runtime.getCell(space, "collection", undefined, tx).getRaw(),
      )!;
      return indexedKindOf(declared, "topics").descriptor;
    }

    /** Reads the rows of the topic `name` through `tx`. */
    function project(
      name: string,
      tx: IExtendedStorageTransaction,
      descriptor = topics(tx),
    ): MemberRows {
      return projectMember(tx, "topics", descriptor, topic(name, tx));
    }

    /** The read log of `tx`, which a V2 transaction keeps as an array. */
    function readLog(tx: IExtendedStorageTransaction): IReadActivity[] {
      return tx.tx.getReadActivities!() as IReadActivity[];
    }

    /** Writes the topic `name` through `tx`. */
    function write(name: string, tx: IExtendedStorageTransaction): void {
      topic(name, tx).set({ title: name, body: "", rank: 0, mentions: [] });
    }

    it("visits only the read-log entries its own reads appended", async () => {
      // The entries are counted through a proxy standing in for the log, so
      // the count is of what the function looked at, whatever time it took.

      await declare({ columns: { title: "text" } });
      const tx = runtime.edit();
      for (const name of ["a", "b", "c"]) write(name, tx);
      const descriptor = topics(tx);
      const log = readLog(tx);
      let visited = 0;
      const counting = new Proxy(log, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) visited++;
          return Reflect.get(target, key, receiver);
        },
      });
      tx.tx.getReadActivities = () => counting;

      const appended: number[] = [];
      const visits: number[] = [];
      for (const name of ["a", "b", "c"]) {
        const before = log.length;
        visited = 0;
        project(name, tx, descriptor);
        appended.push(log.length - before);
        visits.push(visited);
      }

      expect(appended.every((count) => count > 0)).toBe(true);
      expect(visits).toEqual(appended);
      tx.abort();
      await runtime.idle();
    });

    it("leaves out of `deps` a document read before the member was", async () => {
      await declare({ columns: { title: "text" } });
      const tx = runtime.edit();
      write("a", tx);
      write("b", tx);
      topic("a", tx).get();

      const { deps } = project("b", tx);

      expect(deps).toContain(topic("b").getAsNormalizedFullLink().id);
      expect(deps).not.toContain(topic("a").getAsNormalizedFullLink().id);
      tx.abort();
      await runtime.idle();
    });

    it("returns the same `deps` from a read log that is not an array", async () => {
      await declare({ columns: { title: "text" } });
      const tx = runtime.edit();
      write("a", tx);
      write("b", tx);
      topic("a", tx).get();
      const expected = project("b", tx).deps;
      const log = readLog(tx);
      tx.tx.getReadActivities = function* () {
        yield* log;
      };

      const { deps } = project("b", tx);

      expect(deps).not.toContain(topic("a").getAsNormalizedFullLink().id);
      expect(deps).toEqual(expected);
      tx.abort();
      await runtime.idle();
    });
  });

  describe("a field carrying a label", () => {
    /** Commits a topic whose title is read through a document labeled `secret`. */
    async function labeledTopic(name: string): Promise<void> {
      const tx = runtime.edit();
      const held = runtime.getCell(space, `${name}-title`, undefined, tx)
        .getAsNormalizedFullLink();
      writeSeedEnvelopeDoc(tx, space);
      seedStoredEnvelope(tx, { ...toMemorySpaceAddress(held), path: [] }, {
        value: "classified",
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { confidentiality: ["secret"] } }],
          },
        },
      });
      topic(name, tx).setRawUntyped({
        title: runtime.getCellFromLink(held).getAsLink(),
        body: "",
        rank: 0,
      });
      expect((await tx.commit().settled).error).toBeUndefined();
    }

    it("throws from `add()` into a column declaring no label", async () => {
      await declare({ columns: { title: "text" } });
      await labeledTopic("a");
      const tx = runtime.edit();

      expect(() => collection(tx).add("topics", topic("a", tx))).toThrow(
        "does not cover",
      );
      tx.abort();
      await runtime.idle();
    });

    it("throws from `add()` into a column whose label does not cover it", async () => {
      await declare({
        columns: {
          title: { type: "text", ifc: { confidentiality: ["other"] } },
        },
      });
      await labeledTopic("a");
      const tx = runtime.edit();

      expect(() => collection(tx).add("topics", topic("a", tx))).toThrow(
        "does not cover",
      );
      tx.abort();
      await runtime.idle();
    });

    it("mirrors the value into a column whose label covers it", async () => {
      await declare({
        columns: {
          title: { type: "text", ifc: { confidentiality: ["secret"] } },
        },
      });
      await labeledTopic("a");
      const tx = runtime.edit();

      expect(() => collection(tx).add("topics", topic("a", tx))).not.toThrow();
      tx.abort();
      await runtime.idle();
    });

    it("declares the column's label on the table the database is created with", () => {
      const { tables } = defineIndexedCollections({
        topics: {
          columns: {
            title: { type: "text", ifc: { confidentiality: ["secret"] } },
          },
        },
      });

      expect(tables.topics.properties.title.ifc).toEqual({
        confidentiality: ["secret"],
      });
    });
  });

  describe("a field stored per user", () => {
    it("throws from `add()`", async () => {
      await declare({ columns: { title: "text" } });
      const tx = runtime.edit();
      const own = createCell<string>(
        runtime,
        {
          ...runtime.getCell(space, "own-title").getAsNormalizedFullLink(),
          scope: "user",
        },
        tx,
      );
      own.set("mine");
      const cell = topic("a", tx);
      cell.setRawUntyped({ title: own.getAsLink(), body: "", rank: 0 });

      expect(() => collection(tx).add("topics", cell)).toThrow(
        "stored per user",
      );
      tx.abort();
      await runtime.idle();
    });
  });

  describe("a column named as the lookup's own columns are", () => {
    it("follows a write to the member", async () => {
      await declare({ columns: { kind: "text", k: "integer" } });
      await commit((tx) => {
        const cell = runtime.getCell(space, "named", undefined, tx);
        cell.set({ kind: "first", k: 1 });
        collection(tx).add("topics", cell);
      });
      await commit((tx) =>
        runtime.getCell(space, "named", undefined, tx).set({
          kind: "second",
          k: 2,
        })
      );

      expect(await rows("SELECT kind, k FROM topics")).toEqual([
        { kind: "second", k: 2 },
      ]);
    });
  });

  describe("a write to a member", () => {
    beforeEach(async () => {
      await declare({ columns: { title: "text", rank: "integer" } });
      await addTopic("a");
      await addTopic("b");
    });

    it("updates the columns it changes", async () => {
      await commit((tx) => topic("a", tx).key("rank").set(7));

      expect(await rows("SELECT title, rank FROM topics ORDER BY title"))
        .toEqual([{ title: "a", rank: 7 }, { title: "b", rank: 0 }]);
    });

    it("writes one statement for one changed member, however many members there are", async () => {
      for (let n = 0; n < 60; n++) await addTopic(`extra-${n}`);
      const before = await rev();
      await commit((tx) => topic("a", tx).key("rank").set(9));

      // Each statement advances the maintenance revision by one, so the
      // difference counts the statements the re-read wrote.
      expect((await rev()) - before).toBe(1);
    });

    it("leaves the collection's handle unwritten", async () => {
      // A handler that adds to the collection reads the handle, so a write
      // to it here would cost that handler its commit.

      await runtime.idle();
      const handle = () =>
        JSON.stringify(runtime.getCell(space, "collection").getRaw());
      const before = handle();
      await commit((tx) => topic("a", tx).key("rank").set(11));
      await runtime.idle();

      expect(await rows("SELECT rank FROM topics WHERE title = 'a'"))
        .toEqual([{ rank: 11 }]);
      expect(handle()).toBe(before);
    });

    it("leaves the database unwritten when no mirrored field changed", async () => {
      const before = await rev();
      await commit((tx) => topic("a", tx).key("body").set("unmirrored"));

      expect(await rev()).toBe(before);
    });

    it("writes the database when a mirrored field changed", async () => {
      const before = await rev();
      await commit((tx) => topic("a", tx).key("title").set("renamed"));

      expect(await rev()).not.toBe(before);
    });
  });

  describe("a field held through a link", () => {
    it("follows a write to the linked document", async () => {
      await declare({ columns: { title: "text" } });
      await commit((tx) => {
        const shared = runtime.getCell<string>(space, "shared", undefined, tx);
        shared.set("first");
        const cell = topic("a", tx);
        cell.setRawUntyped({ title: shared.getAsLink(), body: "", rank: 0 });
        collection(tx).add("topics", cell);
      });
      expect(await rows("SELECT title FROM topics")).toEqual([
        { title: "first" },
      ]);

      await commit((tx) =>
        runtime.getCell<string>(space, "shared", undefined, tx).set("second")
      );

      expect(await rows("SELECT title FROM topics")).toEqual([
        { title: "second" },
      ]);
    });
  });

  describe("remove()", () => {
    it("deletes the member's rows and references", async () => {
      await declare({ columns: { title: "text" }, relations: ["mentions"] });
      await addTopic("target");
      await addTopic("a", { mentions: [topic("target")] });
      await commit((tx) => collection(tx).remove("topics", topic("a", tx)));

      expect(await rows("SELECT title FROM topics")).toEqual([
        { title: "target" },
      ]);
      expect(await rows("SELECT count(*) AS n FROM topics_mentions")).toEqual([
        { n: 0 },
      ]);
    });

    it("keeps a member removed while its re-read was being looked up", async () => {
      await declare({ columns: { title: "text" } });
      await addTopic("a");
      // Hold the reply to the maintainer's lookup, so that the removal
      // commits between the lookup and the re-read it leads to.
      const provider = storageManager.open(space);
      const query = provider.sqliteQuery!.bind(provider);
      const lookedUp = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      provider.sqliteQuery = async (handle, sql, ...rest) => {
        const reply = await query(handle, sql, ...rest);
        if (sql.includes(":docs") && reply.rows.length > 0) {
          lookedUp.resolve();
          await release.promise;
        }
        return reply;
      };

      const rename = runtime.edit();
      topic("a", rename).key("title").set("renamed");
      await rename.commit().settled;
      await lookedUp.promise;
      const removal = runtime.edit();
      collection(removal).remove("topics", topic("a", removal));
      await removal.commit().settled;
      release.resolve();
      await runtime.settled();

      expect(await rows("SELECT title FROM topics")).toEqual([]);
    });

    it("stops following writes to the removed member", async () => {
      await declare({ columns: { title: "text" } });
      await addTopic("a");
      await commit((tx) => collection(tx).remove("topics", topic("a", tx)));
      const before = await rev();
      await commit((tx) => topic("a", tx).key("title").set("later"));

      expect(await rev()).toBe(before);
    });
  });
});
