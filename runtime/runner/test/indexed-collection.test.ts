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

  /** Commits `fn`, then waits for the maintainer to carry the commit over. */
  async function commit<T>(
    fn: (tx: IExtendedStorageTransaction) => T,
  ): Promise<T> {
    const tx = runtime.edit();
    const result = fn(tx);
    const { error } = await tx.commit().settled;
    expect(error).toBeUndefined();
    await runtime.indexedCollections.settled();
    await runtime.idle();
    await runtime.indexedCollections.settled();
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
        cell.setRaw({ title: shared.getAsLink(), body: "", rank: 0 });
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
