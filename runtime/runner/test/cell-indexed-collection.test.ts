/**
 * The receiver and member checks of the `Cell` methods that maintain an
 * indexed collection, `add()` and `remove()`, driven from a single runtime
 * over emulated storage. Rows are read back with the storage provider's own
 * query.
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
import { defineIndexedCollections } from "../src/builtins/indexed-collection/definition.ts";
import { type Cell, createCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

type Collection = {
  add(kind: string, member: unknown): void;
  remove(kind: string, member: unknown): void;
};

describe("Cell indexed-collection methods", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let space: `did:${string}:${string}`;

  const { tables, index } = defineIndexedCollections({
    topics: { columns: { title: "text" } },
  });

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase(
      `cell-indexed-collection-${crypto.randomUUID()}`,
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
  async function commit(
    fn: (tx: IExtendedStorageTransaction) => void,
  ): Promise<void> {
    const tx = runtime.edit();
    fn(tx);
    const { error } = await tx.commit().settled;
    expect(error).toBeUndefined();
    await runtime.settled();
  }

  /**
   * Commits the handle cell `name` of a collection declaring `topics`, naming
   * the database `id` when given one.
   */
  async function handle(name: string, id?: string): Promise<void> {
    await commit((tx) =>
      runtime.getCell(space, name, undefined, tx).setRawUntyped({
        ...(id !== undefined && { id }),
        tables,
        index,
      })
    );
  }

  function collection(
    name: string,
    tx: IExtendedStorageTransaction,
  ): Collection {
    return createCell(
      runtime,
      runtime.getCell(space, name).getAsNormalizedFullLink(),
      tx,
      false,
      "sqlite",
    ) as unknown as Collection;
  }

  function topic(tx: IExtendedStorageTransaction): Cell<{ title: string }> {
    const cell = runtime.getCell<{ title: string }>(
      space,
      "topic",
      undefined,
      tx,
    );
    cell.set({ title: "a" });
    return cell;
  }

  async function titles(db: SqliteDbRef): Promise<unknown[]> {
    const result = await storageManager.open(space).sqliteQuery!(
      db,
      "SELECT title FROM topics",
    );
    return result.rows;
  }

  describe("add()", () => {
    it("takes a cell as a member, and refuses its value or its link", async () => {
      const db: SqliteDbRef = { id: "topics-db", tables };
      await handle("collection", db.id);

      const tx = runtime.edit();
      const member = topic(tx);
      for (const notACell of [{ title: "a" }, member.getAsLink()]) {
        expect(() => collection("collection", tx).add("topics", notACell))
          .toThrow("an indexed collection holds cells only");
      }
      tx.abort();
      await runtime.idle();

      await commit((tx) =>
        collection("collection", tx).add("topics", topic(tx))
      );
      expect(await titles(db)).toEqual([{ title: "a" }]);
    });

    it("refuses a handle that declares an index but names no database", async () => {
      await handle("nameless");

      const tx = runtime.edit();
      expect(() => collection("nameless", tx).add("topics", topic(tx)))
        .toThrow("only available on an indexed collection");
      tx.abort();
      await runtime.idle();
    });
  });

  describe("remove()", () => {
    it("takes a member out of a handle that names its database", async () => {
      const db: SqliteDbRef = { id: "topics-db", tables };
      await handle("collection", db.id);
      await commit((tx) =>
        collection("collection", tx).add("topics", topic(tx))
      );

      await commit((tx) =>
        collection("collection", tx).remove("topics", topic(tx))
      );
      expect(await titles(db)).toEqual([]);
    });

    it("refuses a handle that declares an index but names no database", async () => {
      await handle("nameless");

      const tx = runtime.edit();
      expect(() => collection("nameless", tx).remove("topics", topic(tx)))
        .toThrow("only available on an indexed collection");
      tx.abort();
      await runtime.idle();
    });

    it("takes a cell as a member, and refuses its value or its link", async () => {
      const db: SqliteDbRef = { id: "topics-db", tables };
      await handle("collection", db.id);
      await commit((tx) =>
        collection("collection", tx).add("topics", topic(tx))
      );

      const tx = runtime.edit();
      const member = topic(tx);
      for (const notACell of [{ title: "a" }, member.getAsLink()]) {
        expect(() => collection("collection", tx).remove("topics", notACell))
          .toThrow("an indexed collection holds cells only");
      }
      tx.abort();
      await runtime.idle();
      expect(await titles(db)).toEqual([{ title: "a" }]);
    });
  });
});
