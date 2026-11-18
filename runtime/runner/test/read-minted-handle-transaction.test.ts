import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("read minted handle transaction");
const space = signer.did();

// The entries are handles and nothing more, so reading the list loads the
// list's document and leaves each entry's document where it is.
const listSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  default: [],
} as const satisfies JSONSchema;

type Leaf = { name?: string };

describe("read-minted-handle-transaction", () => {
  let server: MemoryV2Server.Server;
  let managerA: EmulatedStorageManager;
  let managerB: EmulatedStorageManager;
  let writer: Runtime;
  let reader: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    managerA = EmulatedStorageManager.connectTo(server, { as: signer });
    managerB = EmulatedStorageManager.connectTo(server, { as: signer });
    writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerA,
    });
    reader = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerB,
    });
  });

  afterEach(async () => {
    await writer.dispose();
    await reader.dispose();
    await managerA.close();
    await managerB.close();
    await server.close();
  });

  /** Whether the reader's replica holds the document `cell` names. */
  function localOnReader(cell: Cell<unknown>, inSpace: MemorySpace): boolean {
    const link = cell.getAsNormalizedFullLink();
    const replica = managerB.open(inSpace) as unknown as {
      get?: (uri: string, scope?: unknown) => unknown;
    };
    return replica.get?.(link.id, link.scope) !== undefined;
  }

  /**
   * Writes a leaf and a list whose one entry links to it, and returns the
   * reader's handle on the list, with the leaf's document not yet on the
   * reader's replica.
   */
  async function writeListOf(cause: string) {
    const tx = writer.edit();
    const leaf = writer.getCell<Leaf>(space, `${cause} leaf`, undefined, tx);
    leaf.withTx(tx).set({ name: "Ada" });
    const list = writer.getCell<unknown[]>(
      space,
      `${cause} list`,
      undefined,
      tx,
    );
    list.withTx(tx).set([leaf]);
    writer.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await writer.storageManager.synced();
    const readerList = reader.getCellFromLink<Cell<Leaf>[]>({
      ...list.getAsNormalizedFullLink(),
      schema: listSchema,
    });
    return { leaf, readerList };
  }

  /**
   * Resolves the entry handle, which dead-ends at the leaf's absent document,
   * loads that document, and returns what the handle then reads.
   */
  async function readAfterLoad(entry: Cell<Leaf>, leaf: Cell<Leaf>) {
    const resolved = entry.resolveAsCell();
    expect(localOnReader(leaf, space)).toBe(false);
    await resolved.sync();
    expect(localOnReader(leaf, space)).toBe(true);
    return {
      raw: resolved.getRaw(),
      resolvedAgain: resolved.resolveAsCell().getRaw(),
      entry: entry.getRaw(),
    };
  }

  it("reads an entry's document once it has loaded, through the handle pull() minted", async () => {
    const { leaf, readerList } = await writeListOf("entry after pull");
    const entries = await readerList.pull();
    expect(entries.length).toBe(1);

    expect(await readAfterLoad(entries[0], leaf)).toEqual({
      raw: { name: "Ada" },
      resolvedAgain: { name: "Ada" },
      entry: { name: "Ada" },
    });
  });

  it("reads an entry's document once it has loaded, through the handle a transaction-less get() minted", async () => {
    const { leaf, readerList } = await writeListOf("entry after get");
    await readerList.sync();
    const entries = readerList.get();
    expect(entries.length).toBe(1);

    expect(await readAfterLoad(entries[0], leaf)).toEqual({
      raw: { name: "Ada" },
      resolvedAgain: { name: "Ada" },
      entry: { name: "Ada" },
    });
  });

  it("reads an entry's document once it has loaded, through the handle a transaction-less sample() minted", async () => {
    const { leaf, readerList } = await writeListOf("entry after sample");
    await readerList.sync();
    const entries = readerList.sample();
    expect(entries.length).toBe(1);

    expect(await readAfterLoad(entries[0], leaf)).toEqual({
      raw: { name: "Ada" },
      resolvedAgain: { name: "Ada" },
      entry: { name: "Ada" },
    });
  });

  it("keeps a handle minted through an open transaction on that transaction", async () => {
    const { leaf, readerList } = await writeListOf("entry in open tx");
    await readerList.sync();
    await readerList.get()[0].sync();
    const tx = reader.edit();
    try {
      reader.getCellFromLink<Leaf>(
        leaf.getAsNormalizedFullLink(),
        undefined,
        tx,
      )
        .set({ name: "Grace" });

      // The handle reads the transaction's own uncommitted write, which a
      // handle bound to no transaction cannot see.
      expect(readerList.withTx(tx).get()[0].getRaw()).toEqual({
        name: "Grace",
      });
      expect(readerList.get()[0].getRaw()).toEqual({ name: "Ada" });
    } finally {
      tx.abort();
    }
  });
});
