import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("resolve-as-cell-commit-reads");
const space = signer.did();
const CAUSE = "resolve-as-cell-commit-reads";

type Room = {
  items: (string | { name: string })[];
  title: string;
};

const roomSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: {} },
    title: { type: "string" },
  },
  // deno-lint-ignore no-explicit-any
} as any;

describe("resolve-as-cell-commit-reads", () => {
  let server: MemoryV2Server.Server;
  let storage1: EmulatedStorageManager;
  let storage2: EmulatedStorageManager;
  let rt1: Runtime;
  let rt2: Runtime;

  beforeEach(() => {
    // Manual fan-out, so that the second runtime provably has not received
    // the first runtime's write when it commits its own.
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    storage1 = EmulatedStorageManager.connectTo(server, { as: signer });
    storage2 = EmulatedStorageManager.connectTo(server, { as: signer });
    rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage1,
    });
    rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage2,
    });
  });
  afterEach(async () => {
    await rt2?.dispose();
    await rt1?.dispose();
    await storage1?.close();
    await storage2?.close();
    await server?.close();
  });

  /**
   * Stores `room` as it is written, an object in a list among them staying
   * inline rather than becoming a document of its own, and loads it into the
   * second runtime, so that both hold it at the same revision.
   */
  const seed = async (room: Room): Promise<void> => {
    const tx = rt1.edit();
    rt1.getCell<Room>(space, CAUSE, roomSchema, tx).setRaw(room);
    await tx.commit({ holdSyncedUntilCovered: false }).verdict;
    await rt1.storageManager.synced();
    const loaded = rt2.getCell<Room>(space, CAUSE, roomSchema);
    await loaded.sync();
    await loaded.pull();
    expect(loaded.get()).toEqual(room);
  };

  /** Reads the room as the server holds it, from a session of its own. */
  const readDurable = async (): Promise<unknown> => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const cell = rt.getCell<Room>(space, CAUSE, roomSchema);
      await cell.sync();
      await cell.pull();
      return cell.get();
    } finally {
      await rt.dispose();
      await storage.close();
    }
  };

  it("does not make an append through the resolved cell conflict with another runtime's append to the same list", async () => {
    await seed({ items: ["seed"], title: "Room" });

    const txA = rt1.edit();
    rt1.getCell<Room>(space, CAUSE, roomSchema, txA).key("items").push("A");
    await txA.commit({ holdSyncedUntilCovered: false }).verdict;
    await rt1.storageManager.synced();

    // The second runtime has not seen "A". It resolves the list, as asking
    // which space a cell's value lives in does, and appends to it.
    const txB = rt2.edit();
    const items = rt2.getCell<Room>(space, CAUSE, roomSchema, txB).key(
      "items",
    );
    items.resolveAsCell();
    items.push("B");
    const committed = await txB.commit({ holdSyncedUntilCovered: false })
      .verdict;

    expect(committed.error).toBeUndefined();
    expect(await readDurable()).toEqual({
      items: ["seed", "A", "B"],
      title: "Room",
    });
  });

  it("makes a write that depends on an inline element it resolved to conflict with another runtime's change to that element", async () => {
    await seed({ items: [{ name: "first" }], title: "Room" });

    const txA = rt1.edit();
    rt1.getCell<Room>(space, CAUSE, roomSchema, txA).key("items").key(0)
      .key("name").set("renamed");
    await txA.commit({ holdSyncedUntilCovered: false }).verdict;
    await rt1.storageManager.synced();

    // The second runtime has not seen the rename. A cell resolved to the
    // inline element names a snapshot of the element it saw, so the title it
    // writes from that snapshot rests on the element as it was.
    const txB = rt2.edit();
    const room = rt2.getCell<Room>(space, CAUSE, roomSchema, txB);
    room.key("items").key(0).resolveAsCell();
    room.key("title").set("Room of first");
    const committed = await txB.commit({ holdSyncedUntilCovered: false })
      .verdict;

    expect(committed.error).toBeDefined();
    expect(await readDurable()).toEqual({
      items: [{ name: "renamed" }],
      title: "Room",
    });
  });
});
