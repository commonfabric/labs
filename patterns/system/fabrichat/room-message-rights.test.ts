/**
 * What a FabriChat room's `messageRights` reads before and after a session
 * derives it, from a runtime that runs the room's core directly. A pattern
 * test reads each value only once its computation has run, so it can't see
 * what a reader reads before then; this reads the room's result after the
 * room starts and before anything pulls its computations.
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
      as: await Identity.fromPassphrase("fabrichat room message rights"),
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

  describe("messageRights", () => {
    it("is absent until the session derives it, and then holds one entry per message", async () => {
      const space = storage.as.did();
      const program = await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        { main: ROOM_MAIN, root: PATTERNS_ROOT },
      );
      const compiled = await runtime.patternManager.compilePattern(
        { ...program, mainExport: "FabriChatRoomCore" },
        { space },
      );
      // The room's messages are written here as plain data, outside the
      // room's schema, so its write policy for a stored message doesn't
      // apply.
      const tx = runtime.edit();
      const messages = runtime.getCell(
        space,
        "fabrichat-room-message-rights-messages",
        undefined,
        tx,
      );
      messages.set([{ body: "Hello", sentAt: new FabricEpochNsec(1n) }]);
      const room = runtime.run(
        tx,
        compiled,
        { messages },
        runtime.getCell(space, "fabrichat-room-message-rights", undefined, tx),
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();

      // Nothing has pulled the room's computations yet.
      const rights = room.key("messageRights");
      expect(rights.get()).toBeUndefined();

      // The room has no reader's profile, so the one entry is all `false`.
      await rights.pull();
      expect(rights.get()).toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ body: "Hello" }),
          canEdit: false,
          canDelete: false,
          canObliterate: false,
        }),
      ]);
    });
  });
});
