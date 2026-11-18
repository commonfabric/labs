import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { getCellOrThrow, isCellResult } from "../src/query-result-proxy.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("unknown cross-space signer");
const home = signer.did();

/** A holder whose `room` is typed `unknown`, the stripped form of a handle. */
const HOLDER_SCHEMA = {
  type: "object",
  properties: { room: { type: "unknown" } },
} as const satisfies JSONSchema;

/** What a reader that reads through the room declares of it. */
const ROOM_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
} as const satisfies JSONSchema;

describe("unknown-cross-space-link", () => {
  let server: MemoryV2Server.Server;
  let writer: Runtime;
  let reader: Runtime;
  let elsewhere: MemorySpace;
  let holder: Cell<unknown>;

  /** The documents the reader has received from `elsewhere`, by id. */
  const arrived = new Set<string>();

  beforeEach(async () => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
    elsewhere = await writer.createSpace();
    const targetTx = writer.edit();
    writer.getCell<unknown>(elsewhere, "room", undefined, targetTx)
      .set({ title: "Team" });
    expect((await targetTx.commit().settled).error).toBeUndefined();
    const holderTx = writer.edit();
    holder = writer.getCell<unknown>(home, "holder", undefined, holderTx);
    holder.set({ room: writer.getCell<unknown>(elsewhere, "room") });
    expect((await holderTx.commit().settled).error).toBeUndefined();
    await writer.storageManager.synced();

    arrived.clear();
    reader = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
    reader.storageManager.subscribe({
      next(notification) {
        if (
          notification.space === elsewhere && notification.type !== "reset" &&
          "changes" in notification
        ) {
          for (const change of notification.changes) {
            arrived.add(change.address.id);
          }
        }
        return undefined;
      },
    });
  });

  afterEach(async () => {
    await reader.dispose();
    await writer.dispose();
    await server.close();
  });

  /** The holder's `room`, as the reader reads it under `HOLDER_SCHEMA`. */
  const readRoom = async (): Promise<unknown> => {
    const read = reader.getCellFromLink(
      holder.getAsNormalizedFullLink(),
      HOLDER_SCHEMA,
    );
    await read.pull();
    await reader.storageManager.synced();
    return (read.get() as { room?: unknown } | undefined)?.room;
  };

  it("reads the position as present without loading the linked document", async () => {
    const room = await readRoom();

    expect(isCellResult(room)).toBe(true);
    expect(getCellOrThrow(room).getAsNormalizedFullLink().space).toBe(
      elsewhere,
    );
    expect(arrived.size).toBe(0);
  });

  it("loads the linked document for a reader that reads through it", async () => {
    const room = await readRoom();
    const through = reader.getCellFromLink(
      getCellOrThrow(room).getAsNormalizedFullLink(),
      ROOM_SCHEMA,
    );
    await through.pull();

    expect(through.get()).toEqual({ title: "Team" });
    expect(arrived.size).toBeGreaterThan(0);
  });
});
