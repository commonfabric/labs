/**
 * Drives an indexed collection whose handle names the one module that may
 * write it: what that module adds lands, what another module adds, removes or
 * executes is refused with its database write, and maintenance still follows
 * the members.
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
import type { JSONSchema } from "../src/builder/types.ts";
import { type Cell, createCell } from "../src/cell.ts";
import type { ImplementationIdentity } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const BOARD_MODULE = "board-module-identity";
const BOARD_FILE = "/patterns/board.tsx";

/** The handler the handle's claim names. */
const asBoard: ImplementationIdentity = {
  kind: "verified",
  moduleIdentity: BOARD_MODULE,
  sourceFile: BOARD_FILE,
  bindingPath: ["addTopic"],
};

/** A verified handler of another module, which holds the handle too. */
const asTopic: ImplementationIdentity = {
  kind: "verified",
  moduleIdentity: "topic-module-identity",
  sourceFile: "/patterns/topic.tsx",
  bindingPath: ["mention"],
};

/** The handle's schema: writable by the board's handler alone. */
const HANDLE_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: true,
  ifc: {
    writeAuthorizedBy: {
      __ctWriterIdentityOf: {
        moduleIdentity: BOARD_MODULE,
        file: BOARD_FILE,
        path: ["addTopic"],
      },
    },
  },
} as JSONSchema;

type Collection = Cell<unknown> & {
  exec(sql: string, params?: unknown[]): void;
  add(kind: string, member: unknown): void;
  remove(kind: string, member: unknown): void;
};

describe("indexed-collection-write-authority", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let space: `did:${string}:${string}`;
  let db: SqliteDbRef;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase(
      `indexed-collection-write-authority-${crypto.randomUUID()}`,
    );
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: "indexed-collection-write-authority",
        actingPrincipal: signer.did(),
      }),
    });
    const { tables, index } = defineIndexedCollections({
      topics: { columns: { title: "text" } },
    });
    expect(
      await commit(asBoard, (tx) => {
        const handle = runtime.getCell(space, "collection", HANDLE_SCHEMA, tx);
        const id = handle.getAsNormalizedFullLink().id.replace(/^of:/, "");
        db = { id, tables };
        handle.set({ ...db, index });
      }),
    ).toBeUndefined();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Commits `fn` as `identity`, and returns the commit's error message. */
  async function commit(
    identity: ImplementationIdentity,
    fn: (tx: IExtendedStorageTransaction) => void,
  ): Promise<string | undefined> {
    const tx = runtime.edit();
    setCfcImplementationIdentity(tx, identity);
    fn(tx);
    tx.prepareCfc();
    const error = (await tx.commit().settled).error?.message;
    await runtime.settled();
    return error;
  }

  /**
   * The collection as a holder of its handle has it: a link that carries no
   * schema, so the claim that gates a write is the one the document stores.
   */
  function collection(tx: IExtendedStorageTransaction): Collection {
    return createCell(
      runtime,
      runtime.getCell(space, "collection")
        .getAsNormalizedFullLink(),
      tx,
      false,
      "sqlite",
    ) as unknown as Collection;
  }

  function topic(name: string, tx?: IExtendedStorageTransaction) {
    return runtime.getCell<{ title: string }>(
      space,
      `topic-${name}`,
      undefined,
      tx,
    );
  }

  /** Writes the topic `name` and adds it to the collection, as `identity`. */
  function add(identity: ImplementationIdentity, name: string) {
    return commit(identity, (tx) => {
      const cell = topic(name, tx);
      cell.set({ title: name });
      collection(tx).add("topics", cell);
    });
  }

  async function titles(): Promise<unknown[]> {
    const result = await storageManager.open(space).sqliteQuery!(
      db,
      "SELECT title FROM topics ORDER BY title",
    );
    return result.rows.map((row) => (row as { title: unknown }).title);
  }

  it("commits an add made by the module the handle's claim names", async () => {
    expect(await add(asBoard, "a")).toBeUndefined();
    expect(await titles()).toEqual(["a"]);
  });

  it("refuses an add made by another module, and writes no row", async () => {
    expect(await add(asBoard, "a")).toBeUndefined();
    expect(await add(asTopic, "b")).toMatch(/writeAuthorizedBy failed/);
    expect(await titles()).toEqual(["a"]);
  });

  it("refuses a remove made by another module, and keeps the row", async () => {
    expect(await add(asBoard, "a")).toBeUndefined();
    expect(
      await commit(asTopic, (tx) => {
        collection(tx).remove("topics", topic("a", tx));
      }),
    ).toMatch(/writeAuthorizedBy failed/);
    expect(await titles()).toEqual(["a"]);
  });

  it("refuses a statement executed by another module, and keeps the table", async () => {
    expect(await add(asBoard, "a")).toBeUndefined();
    expect(
      await commit(asTopic, (tx) => {
        collection(tx).exec("DELETE FROM topics");
      }),
    ).toMatch(/writeAuthorizedBy failed/);
    expect(await titles()).toEqual(["a"]);
  });

  it("follows a member's write made by another module", async () => {
    // Maintenance writes the collection's tables and not its handle, so the
    // claim on the handle is no part of it.

    expect(await add(asBoard, "a")).toBeUndefined();
    expect(
      await commit(asTopic, (tx) => topic("a", tx).key("title").set("renamed")),
    ).toBeUndefined();
    expect(await titles()).toEqual(["renamed"]);
  });
});
