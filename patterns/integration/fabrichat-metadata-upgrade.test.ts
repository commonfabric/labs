/**
 * Reopens populated FabriChat rooms from disk before updating their source.
 * The room and schema snapshots are byte-for-byte copies from 4efa1c0882,
 * before room metadata. The producer-only manager snapshot from 27d9003f4a
 * keeps the seed graph compatible with those schemas; dependencies retain
 * their production paths.
 * This storage-only server deliberately exercises client execution (OFF).
 */

import { expect } from "@std/expect";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  type Cell,
  getPatternIdentityRef,
  getPatternSource,
  idStringForEntityAddress,
  Runtime,
} from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

const patterns = fromFileUrl(new URL("..", import.meta.url));
const roomSource = "system:system/fabrichat/room.tsx";

/** Keeps the storage address, excluding the reader's schema and traversal marks. */
function address(cell: Cell<unknown>) {
  const { space, id, path, scope } = cell.getAsNormalizedFullLink();
  return { space, id, path, scope };
}

/** Reads a stored record, retaining links rather than expanding their values. */
async function snapshot(cell: Cell<unknown>) {
  const resolved = cell.resolveAsCell();
  await resolved.sync();
  return {
    link: address(resolved),
    value: resolved.getRaw(),
  };
}

describe("FabriChat metadata upgrade", () => {
  for (const mode of ["explicit", "automatic-cold", "unchanged"] as const) {
    it(`preserves populated room records through ${mode} reopen`, async () => {
      await using cleanup = new AsyncDisposableStack();
      const owner = await Identity.fromPassphrase(`metadata upgrade ${mode}`);
      const temporary = await Deno.makeTempDir({ prefix: "chat-upgrade-" });
      cleanup.defer(() => Deno.remove(temporary, { recursive: true }));
      const vintageSystem = join(temporary, "system");
      await Deno.mkdir(join(vintageSystem, "fabrichat"), { recursive: true });
      for await (const entry of Deno.readDir(join(patterns, "system"))) {
        if (entry.name !== "fabrichat") {
          await Deno.symlink(
            join(patterns, "system", entry.name),
            join(vintageSystem, entry.name),
          );
        }
      }
      const oldSources = new Map<string, string>();
      for await (
        const entry of Deno.readDir(join(patterns, "system/fabrichat"))
      ) {
        const destination = join(vintageSystem, "fabrichat", entry.name);
        if (["manager.tsx", "room.tsx", "schemas.tsx"].includes(entry.name)) {
          const contents = await Deno.readTextFile(
            new URL(
              `./fixtures/${
                entry.name === "manager.tsx"
                  ? "fabrichat-manager-demand"
                  : "fabrichat-metadata-upgrade"
              }/${entry.name.replace(".tsx", "-before.tsx.txt")}`,
              import.meta.url,
            ),
          );
          oldSources.set(`/system/fabrichat/${entry.name}`, contents);
          await Deno.writeTextFile(destination, contents);
        } else {
          await Deno.symlink(
            join(patterns, "system/fabrichat", entry.name),
            destination,
          );
        }
      }
      let route = new PatternsRoute(patterns, [{
        routePrefix: "system/",
        directory: vintageSystem,
      }]);
      const http = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        async (request) =>
          await route.serve(request) ??
            new Response("Not found", { status: 404 }),
      );
      cleanup.defer(() => http.shutdown());
      const apiUrl = new URL(`http://127.0.0.1:${http.addr.port}`);
      let server = newLoopbackServer({
        store: toFileUrl(`${temporary}/store/`),
      });
      cleanup.defer(() => server.close());
      let storage = EmulatedStorageManager.connectTo(server, { as: owner });
      cleanup.defer(() => storage.close());
      let runtime = new Runtime({
        apiUrl,
        storageManager: storage,
        experimental: { serverExecution: false },
      });
      cleanup.defer(() => runtime.dispose());
      let homeController = new PiecesController(
        createSession({ identity: owner, spaceDid: owner.did() }),
        runtime,
      );
      cleanup.defer(() => homeController.dispose());
      let roomController: PiecesController | undefined;
      cleanup.defer(async () => {
        await roomController?.dispose();
      });
      /** Sends the same reviewed host gesture that the room's UI sends. */
      const send = async (
        cell: Cell<unknown>,
        handler: string,
        value: object,
        action?: string,
      ) => {
        const event = action === undefined ? value : {
          type: "click",
          ...value,
          provenance: reviewedActionProvenance("dom", {
            surface: `${action}Surface`,
            action,
          }),
        };
        if (action !== undefined) markRendererTrustedEvent(event);
        const { error } = await runtime.editWithRetry((tx) =>
          cell.withTx(tx).key(handler).send(event)
        );
        expect(error).toBeUndefined();
        await runtime.idle();
        await storage.synced();
      };
      {
        const previous = await resolveLocalProgram(
          (resolver) => runtime.harness.resolve(resolver),
          {
            main: join(
              patterns,
              "integration/fixtures/fabrichat-add-offer/main.tsx",
            ),
            root: patterns,
          },
        );
        for (const [name, contents] of oldSources) {
          const file = previous.files.find((entry) => entry.name === name);
          expect(file).toBeDefined();
          file!.contents = contents;
        }
        const home = (await homeController.create(
          previous,
          { start: true },
          `old room home ${mode}`,
        )).getCell();
        await runtime.idle();
        expect(
          (await runtime.editWithRetry((tx) => {
            runtime.getHomeSpaceCell(tx).key("defaultPattern").set(home);
          })).error,
        ).toBeUndefined();
        await send(home, "createProfile", { name: "Ada" });
        await send(home, "createGroup", {
          requestId: "old",
          title: "Original title",
          members: [],
        }, "ChatStart");
        expect(await home.key("requests").key("old").key("status").pull()).toBe(
          "done",
        );
        let room = home.key("requests").key("old").key("entry").key("room")
          .resolveAsCell();
        const roomLink = address(room);
        roomController = new PiecesController(
          createSession({ identity: owner, spaceDid: roomLink.space }),
          runtime,
        );
        const oldPiece = await roomController.get(roomLink.id, true);
        // A manager-created child initially carries its parent's compiled
        // closure. Following the deployed old source establishes the ordinary
        // standalone room identity before any retained messages are written.
        const followed = await oldPiece.changeSource({
          kind: "repoint",
          url: roomSource,
        });
        expect(followed.status).toBe("applied");
        room = oldPiece.getCell();
        await send(
          room,
          "sendMessage",
          { body: "Original message" },
          "ChatSend",
        );
        await send(room, "sendMessage", { body: "Second message" }, "ChatSend");
        await send(room, "setTitle", {
          requestId: "old-title",
          title: "Stored title",
        }, "ChatRetitle");
        expect(await room.key("messages").key("count").pull()).toBe(2);
        expect(await room.key("metadata").pull()).toBeUndefined();
        const original = room.key("messages").key("latest").key("messages").key(
          0,
        ).resolveAsCell();
        const messageBefore = await snapshot(original);
        const secondBefore = await snapshot(
          room.key("messages").key("latest").key("messages").key(1),
        );
        const rosterBefore = await snapshot(room.key("roster"));
        const aboutBefore = await snapshot(room.key("about"));
        const identityBefore = getPatternIdentityRef(room)?.identity;
        expect(identityBefore).toBeDefined();
        expect(identityBefore).toBe(
          await route.identity("system/fabrichat/room.tsx"),
        );
        await runtime.idle();
        await storage.synced();
        await roomController.dispose();
        await homeController.dispose();
        await runtime.dispose();
        await storage.close();
        await server.close();
        server = newLoopbackServer({ store: toFileUrl(`${temporary}/store/`) });
        if (mode !== "unchanged") route = new PatternsRoute(patterns);
        storage = EmulatedStorageManager.connectTo(server, { as: owner });
        runtime = new Runtime({
          apiUrl,
          storageManager: storage,
          experimental: { serverExecution: false },
        });
        homeController = new PiecesController(
          createSession({ identity: owner, spaceDid: owner.did() }),
          runtime,
        );
        roomController = new PiecesController(
          createSession({ identity: owner, spaceDid: roomLink.space }),
          runtime,
        );
        if (mode === "explicit") {
          const candidate = await resolveLocalProgram(
            (resolver) => runtime.harness.resolve(resolver),
            {
              main: join(patterns, "system/fabrichat/room.tsx"),
              root: patterns,
            },
          );
          const receipt = await (await roomController.get(roomLink.id))
            .setPattern(candidate);
          expect(receipt.status).toBe("committed");
          expect(receipt.refresh.status).toBe("completed");
          expect(receipt.detachedOrigin).toBe(roomSource);
        }
        room = (await roomController.get(roomLink.id, true)).getCell();
        await runtime.idle();
        await room.pull();
        expect(address(room)).toEqual(roomLink);
        expect(getPatternSource(room)).toBe(
          mode === "explicit" ? undefined : roomSource,
        );
        if (mode === "unchanged") {
          expect(getPatternIdentityRef(room)?.identity).toBe(identityBefore);
        } else {
          expect(getPatternIdentityRef(room)?.identity).not.toBe(
            identityBefore,
          );
        }
        if (mode !== "explicit") {
          expect(getPatternIdentityRef(room)?.identity).toBe(
            await route.identity("system/fabrichat/room.tsx"),
          );
        }
        expect(await snapshot(room.key("about"))).toEqual(aboutBefore);
        expect(await snapshot(room.key("roster"))).toEqual(rosterBefore);
        expect(
          await snapshot(
            room.key("messages").key("latest").key("messages").key(0),
          ),
        ).toEqual(messageBefore);
        expect(
          await snapshot(
            room.key("messages").key("latest").key("messages").key(1),
          ),
        ).toEqual(secondBefore);
        const retained = runtime.getCellFromLink(messageBefore.link);
        expect(await snapshot(retained)).toEqual(messageBefore);
        expect(await room.key("messages").key("count").pull()).toBe(2);
        if (mode === "unchanged") {
          expect(await room.key("metadata").pull()).toBeUndefined();
        } else {
          const navigation = room.key("metadata").key("room");
          expect(await navigation.key("space").pull()).toBe(roomLink.space);
          const roomId = await navigation.key("id").asSchema<string>({
            type: "string",
          }).pull();
          expect(idStringForEntityAddress(roomId)).toBe(roomLink.id);
          expect(await room.key("metadata").key("kind").pull()).toBe("group");
          expect(await room.key("metadata").key("title").pull()).toBe(
            "Stored title",
          );
        }
        // These writes target records created by the old source, so changed
        // writer-policy identities cannot silently leave the room read-only.
        await send(room, "editMessage", {
          message: retained,
          body: "Edited original",
        }, "ChatEdit");
        expect(await retained.key("body").pull()).toBe("Edited original");
        await send(room, "setTitle", {
          requestId: "new-title",
          title: "Updated title",
        }, "ChatRetitle");
        await send(room, "sendMessage", { body: "After reopen" }, "ChatSend");
        expect(await room.key("messages").key("count").pull()).toBe(3);
        expect(await room.key("about").key("title").pull()).toBe(
          "Updated title",
        );
        if (mode !== "unchanged") {
          expect(await room.key("metadata").key("kind").pull()).toBe("group");
          expect(await room.key("metadata").key("title").pull()).toBe(
            "Updated title",
          );
        }
      }
    });
  }
});
