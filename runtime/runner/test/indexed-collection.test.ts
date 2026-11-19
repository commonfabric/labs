/**
 * Drives an indexed collection from a single runtime over emulated storage:
 * the handle is minted directly, members are added through the cell method a
 * handler would call, and rows are read back with the storage provider's own
 * query, so every assertion is about what the database holds.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { SqliteDbRef } from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  defineIndexedCollection,
  type IndexedCollectionOptions,
} from "../src/builtins/indexed-collection/definition.ts";
import { memberKeyOf } from "../src/builtins/indexed-collection/maintenance.ts";
import { type Cell, createCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

type Topic = { title: string; body: string; rank: number; mentions: unknown[] };

type Collection = {
  add(member: unknown): void;
  remove(member: unknown): void;
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
  async function declare(options: IndexedCollectionOptions): Promise<void> {
    const { tables, index } = defineIndexedCollection(options);
    await commit((tx) => {
      const handle = runtime.getCell(space, "collection", undefined, tx);
      const id = handle.getAsNormalizedFullLink().id.replace(/^of:/, "");
      db = { id, tables };
      handle.setRaw({ ...db, index });
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
      collection(tx).add(cell);
    });
  }

  async function rows(sql: string): Promise<Record<string, unknown>[]> {
    const result = await storageManager.open(space).sqliteQuery!(db, sql);
    return result.rows as Record<string, unknown>[];
  }

  async function rev(): Promise<unknown> {
    await runtime.idle();
    return (runtime.getCell(space, "collection").getRaw() as { rev?: number })
      .rev;
  }

  describe("add()", () => {
    it("mirrors the declared columns of the member", async () => {
      await declare({ columns: { title: "text", rank: "integer" } });
      await addTopic("a", { rank: 3 });

      expect(await rows("SELECT title, rank FROM members")).toEqual([
        { title: "a", rank: 3 },
      ]);
    });

    it("stores the member under its cell reference", async () => {
      await declare({ columns: { title: "text" } });
      await addTopic("a");

      expect(await rows("SELECT member_cf_link FROM members")).toEqual([
        { member_cf_link: memberKeyOf(topic("a")) },
      ]);
    });

    it("refreshes the rows of a member added twice", async () => {
      await declare({ columns: { title: "text" } });
      await addTopic("a");
      await addTopic("a", { title: "again" });

      expect(await rows("SELECT title FROM members")).toEqual([
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

      expect(() => collection(tx).add(foreign)).toThrow("its own space");
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

      expect(() => plain.add(topic("a", tx))).toThrow("indexed collection");
      tx.abort();
      await runtime.idle();
    });
  });

  describe("relations", () => {
    const mentioning = "SELECT m.title FROM mentions e JOIN members m " +
      "ON m.member_cf_link = e.source_cf_link WHERE e.target_cf_link = " +
      "(SELECT member_cf_link FROM members WHERE title = 'target') " +
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

      expect(await rows("SELECT count(*) AS n FROM mentions")).toEqual([
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
        collection(tx).add(cell);
      });

      expect(await rows("SELECT title, author FROM members")).toEqual([
        { title: "a", author: "Ada" },
      ]);
    });

    it("stores `NULL` where the member has nothing at the path", async () => {
      await addTopic("a");

      expect(await rows("SELECT title, author FROM members")).toEqual([
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

      expect(await rows("SELECT author FROM members")).toEqual([
        { author: "Grace" },
      ]);
    });
  });

  describe("a relation holding one reference", () => {
    const parents = "SELECT c.title AS child, p.title AS parent " +
      "FROM parent e JOIN members c ON c.member_cf_link = e.source_cf_link " +
      "JOIN members p ON p.member_cf_link = e.target_cf_link ORDER BY c.title";

    beforeEach(async () => {
      await declare({ columns: { title: "text" }, relations: ["parent"] });
      await addTopic("root");
    });

    it("stores one row for the reference", async () => {
      await commit((tx) => {
        const cell = topic("a", tx);
        cell.setRawUntyped({ title: "a", parent: topic("root").getAsLink() });
        collection(tx).add(cell);
      });

      expect(await rows(parents)).toEqual([{ child: "a", parent: "root" }]);
    });

    it("stores no row for a member holding no reference", async () => {
      await addTopic("a");

      expect(await rows("SELECT count(*) AS n FROM parent")).toEqual([
        { n: 0 },
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

      expect(await rows("SELECT title, rank FROM members ORDER BY title"))
        .toEqual([{ title: "a", rank: 7 }, { title: "b", rank: 0 }]);
    });

    it("writes one statement for one changed member, however many members there are", async () => {
      for (let n = 0; n < 60; n++) await addTopic(`extra-${n}`);
      const before = await rev() as number;
      await commit((tx) => topic("a", tx).key("rank").set(9));

      // Each statement advances the handle's revision by one, so the
      // difference counts the statements the re-read wrote.
      expect((await rev() as number) - before).toBe(1);
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
        collection(tx).add(cell);
      });
      expect(await rows("SELECT title FROM members")).toEqual([
        { title: "first" },
      ]);

      await commit((tx) =>
        runtime.getCell<string>(space, "shared", undefined, tx).set("second")
      );

      expect(await rows("SELECT title FROM members")).toEqual([
        { title: "second" },
      ]);
    });
  });

  describe("remove()", () => {
    it("deletes the member's rows and references", async () => {
      await declare({ columns: { title: "text" }, relations: ["mentions"] });
      await addTopic("target");
      await addTopic("a", { mentions: [topic("target")] });
      await commit((tx) => collection(tx).remove(topic("a", tx)));

      expect(await rows("SELECT title FROM members")).toEqual([
        { title: "target" },
      ]);
      expect(await rows("SELECT count(*) AS n FROM mentions")).toEqual([
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
        if (sql.startsWith("WITH affected") && reply.rows.length > 0) {
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
      collection(removal).remove(topic("a", removal));
      await removal.commit().settled;
      release.resolve();
      await runtime.settled();

      expect(await rows("SELECT title FROM members")).toEqual([]);
    });

    it("stops following writes to the removed member", async () => {
      await declare({ columns: { title: "text" } });
      await addTopic("a");
      await commit((tx) => collection(tx).remove(topic("a", tx)));
      const before = await rev();
      await commit((tx) => topic("a", tx).key("title").set("later"));

      expect(await rev()).toBe(before);
    });
  });
});
