/**
 * What a FabriChat room derives from stored messages that include one its
 * schema doesn't accept, from a runtime that runs the room's core directly.
 * No handler stores such a message, so a pattern test, which writes through
 * the room's handlers, can't make one; this writes the room's messages as
 * plain data.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { FabricEpochNsec } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";

const PATTERNS_ROOT = fromFileUrl(new URL("../..", import.meta.url));
const ROOM_MAIN = fromFileUrl(new URL("./room.tsx", import.meta.url));

describe("room", () => {
  let storage: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(async () => {
    storage = EmulatedStorageManager.emulate({
      as: await Identity.fromPassphrase("fabrichat room malformed messages"),
    });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  /**
   * Runs the room's core over `malformed` stored between two well-formed
   * messages, and returns the room's result.
   */
  const roomAround = async (malformed: Record<string, unknown>) => {
    const space = storage.as.did();
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      { main: ROOM_MAIN, root: PATTERNS_ROOT },
    );
    const compiled = await runtime.patternManager.compilePattern(
      { ...program, mainExport: "FabriChatRoomCore" },
      { space },
    );
    // The messages are written as plain data, outside the room's schema, so
    // neither its write policy nor its types apply.
    const tx = runtime.edit();
    const messages = runtime.getCell<unknown[]>(
      space,
      "fabrichat-room-malformed-messages-messages",
      undefined,
      tx,
    );
    messages.set([
      { body: "Before", sentAt: new FabricEpochNsec(1n) },
      malformed,
      { body: "After", sentAt: new FabricEpochNsec(3n) },
    ]);
    const room = runtime.run(
      tx,
      compiled,
      { messages },
      runtime.getCell(
        space,
        "fabrichat-room-malformed-messages",
        undefined,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    return room;
  };

  /** Checks that `room` derives the two well-formed messages and only them. */
  const expectOnlyWellFormed = async (
    room: Awaited<ReturnType<typeof roomAround>>,
  ) => {
    const list = room.key("messages");
    await list.pull();
    expect(list.get()).toEqual(expect.objectContaining({
      count: 2,
      oldestAt: new FabricEpochNsec(1n),
      newestAt: new FabricEpochNsec(3n),
      latest: {
        messages: [
          expect.objectContaining({ body: "Before" }),
          expect.objectContaining({ body: "After" }),
        ],
        hasOlder: false,
      },
    }));

    const rights = room.key("messageRights");
    await rights.pull();
    expect(rights.get()).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ body: "Before" }),
      }),
      expect.objectContaining({
        message: expect.objectContaining({ body: "After" }),
      }),
    ]);
  };

  describe("a stored message its schema doesn't accept", () => {
    it("is left out when its `sentAt` is a bare bigint", async () => {
      await expectOnlyWellFormed(await roomAround({ body: "Bad", sentAt: 2n }));
    });

    it("is left out when its `body` is neither text nor the deleted marker", async () => {
      await expectOnlyWellFormed(
        await roomAround({ body: 42, sentAt: new FabricEpochNsec(2n) }),
      );
    });

    it("is left out when it lacks a `sentAt`", async () => {
      await expectOnlyWellFormed(await roomAround({ body: "Bad" }));
    });
  });
});
