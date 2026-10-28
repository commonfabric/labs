/**
 * Replays the real Home before its shared-space interface, then updates it in
 * place through explicit updates and normal system-origin Home opens. The
 * HTTP route serves real source and closure identities; populated storage is
 * retained across runtime restarts. Both releases use the production manager.
 */

import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { deepFreeze } from "@commonfabric/data-model";
import {
  FabricDurationNsec,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";
import {
  ensurePrivateInboxOf,
  PiecesController,
} from "@commonfabric/piece/ops";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import {
  type Cell,
  getDerivedInternalCellLink,
  getPatternIdentityRef,
  getPatternSource,
  parseLink,
  Runtime,
  sendEvent,
} from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

const owner = await Identity.fromPassphrase("Home interface state retention");

/**
 * Counts the stored argument slots a pattern's setup has dropped, across every
 * runtime in this process. The count is kept even when the warning is filtered.
 */
const droppedSlots = (): number =>
  getLoggerCountsBreakdown().runner?.["setup-stored-slot-dropped"]?.total ?? 0;

describe("Home interface upgrade", () => {
  for (
    const { mode, fixture, suffix, hasInboxRequests, update } of [
      { fixture: "home-before.tsx.txt", suffix: "", hasInboxRequests: false },
      {
        fixture: "home-with-inbox-request.tsx.txt",
        suffix: " from the inbox-request Home",
        hasInboxRequests: true,
      },
    ].flatMap((release) => [
      ...(["explicit", "automatic-running", "automatic-cold"] as const).map(
        (mode) => ({ ...release, mode, update: true }),
      ),
      ...(release.hasInboxRequests
        ? (["automatic-running", "automatic-cold"] as const).map((mode) => ({
          ...release,
          mode,
          update: false,
        }))
        : []),
    ])
  ) {
    const description = !update
      ? `retains populated Home state through a ${
        mode === "automatic-cold" ? "cold" : "running"
      } system-origin reopen without a source update`
      : mode === "explicit"
      ? "preserves manager requests, direct counterparts and queued notices across the Home code change"
      : `preserves populated Home and manager state through a ${
        mode === "automatic-cold" ? "cold" : "running"
      } system-origin update`;
    it(description + suffix, async () => {
      const server = newLoopbackServer();
      const patterns = fromFileUrl(new URL("..", import.meta.url));
      const temporary = await Deno.makeTempDir({
        prefix: "home-origin-rehearsal-",
      });
      const vintageSystem = join(temporary, "system");
      await Deno.mkdir(vintageSystem);
      for await (const entry of Deno.readDir(join(patterns, "system"))) {
        if (entry.name === "home.tsx") continue;
        await Deno.symlink(
          join(patterns, "system", entry.name),
          join(vintageSystem, entry.name),
        );
      }
      const oldHome = await Deno.readTextFile(
        new URL(
          `./fixtures/home-interface-upgrade/${fixture}`,
          import.meta.url,
        ),
      );
      await Deno.writeTextFile(join(vintageSystem, "home.tsx"), oldHome);
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
      const apiUrl = new URL(`http://127.0.0.1:${http.addr.port}`);
      let storage = EmulatedStorageManager.connectTo(server, { as: owner });
      let runtime = new Runtime({
        apiUrl,
        storageManager: storage,
      });
      let controller = new PiecesController(
        createSession({ identity: owner, spaceDid: owner.did() }),
        runtime,
      );
      try {
        const candidate = await resolveLocalProgram(
          (resolver) => runtime.harness.resolve(resolver),
          {
            main: fromFileUrl(new URL("../system/home.tsx", import.meta.url)),
            root: fromFileUrl(new URL("..", import.meta.url)),
          },
        );
        const previous = structuredClone(candidate);
        const entry = previous.files.find((file) =>
          file.name === previous.main
        );
        expect(entry).toBeDefined();
        // Snapshots of Home at `676e4cae1b` and `181f2464ac`, before the
        // interface change. Retaining the entry path keeps each production
        // dependency's identity intact.
        entry!.contents = oldHome;
        let home: Cell<unknown>;
        if (mode === "explicit") {
          const compiled = await runtime.patternManager.compilePattern(
            previous,
            { space: owner.did() },
          );
          const tx = runtime.edit();
          home = runtime.run(
            tx,
            compiled,
            {},
            runtime.getCell(owner.did(), "upgrade Home", undefined, tx),
          );
          runtime.getSpaceCell(owner.did(), undefined, tx).key("defaultPattern")
            .set(home);
          runtime.prepareTxForCommit(tx);
          expect((await tx.commit().settled).error).toBeUndefined();
        } else {
          home = (await controller.ensureDefaultPattern()).getCell();
          expect(getPatternSource(home)).toBe("system:system/home.tsx");
          expect(getPatternIdentityRef(home)?.identity).toBe(
            await route.identity("system/home.tsx"),
          );
        }
        await runtime.idle();
        await home.pull();

        await ensurePrivateInboxOf(runtime, home, owner.did());
        await runtime.idle();
        const earlierInbox = await home.key("privateInbox").key("piece")
          .asSchema<Cell<unknown>>({ asCell: ["cell"] }).pull();
        expect(earlierInbox).toBeDefined();
        const retainTx = runtime.edit();
        home.withTx(retainTx).key("privateInbox").set({});
        home.withTx(retainTx).key("retainedPrivateInboxes").set([earlierInbox]);
        runtime.prepareTxForCommit(retainTx);
        expect((await retainTx.commit().settled).error).toBeUndefined();
        await ensurePrivateInboxOf(runtime, home, owner.did());
        await runtime.idle();
        const heldInbox = await home.key("privateInbox").key("piece")
          .asSchema<Cell<unknown>>({ asCell: ["cell"] }).pull();
        expect(heldInbox).toBeDefined();
        expect(heldInbox.equalLinks(earlierInbox)).toBe(false);
        const create = {
          type: "click",
          target: { value: "Retained profile" },
          provenance: reviewedActionProvenance("dom", {
            surface: "ProfileCreateSurface",
            action: "CreateProfile",
          }),
        };
        markRendererTrustedEvent(create);
        const createTx = runtime.edit();
        home.withTx(createTx).key("createProfile").send(create);
        runtime.prepareTxForCommit(createTx);
        expect((await createTx.commit().settled).error).toBeUndefined();
        await runtime.idle();
        const profiles = await home.key("profiles").asSchema<Cell<unknown>[]>({
          type: "array",
          items: { asCell: ["cell"] },
        }).pull();
        expect(profiles).toHaveLength(1);
        let retainedRequest: Record<string, boolean> = {};
        if (hasInboxRequests) {
          await new Promise<void>((resolve, reject) =>
            sendEvent(
              home.key("requestPrivateInbox"),
              { from: profiles[0] },
              (tx) => {
                if (tx.status().status === "error") {
                  reject(new Error("Inbox request failed"));
                } else resolve();
              },
            )
          );
          await runtime.idle();
          retainedRequest = await runtime.getCellFromLink(
            getDerivedInternalCellLink(home, {
              partialCause: "privateInboxRequests",
            }),
          ).asSchema<Record<string, boolean>>({
            type: "object",
            additionalProperties: { type: "boolean" },
          }).pull();
          expect(Object.values(retainedRequest)).toEqual([true]);
        }

        const social = await runtime.createSpace({});
        const roomTx = runtime.edit();
        const room = runtime.getCell(social, "direct room", undefined, roomTx);
        // The seed fits the manager's schema, so a candidate that changes the
        // manager is judged on retention rather than refused at swap setup.
        const policy = runtime.getCell(
          social,
          "room policy",
          undefined,
          roomTx,
        );
        policy.set({
          ownersMayObliterate: false,
          keepsHistory: true,
          deletionIsObliteration: false,
          proposedTimeMaxAgeNsec: new FabricDurationNsec(1000n),
          proposedTimeMaxLeadNsec: new FabricDurationNsec(1000n),
          recentActivityWindowNsec: new FabricDurationNsec(1000n),
          maxWindowCount: 10,
          maxOpenWindows: 2,
        });
        room.set({ about: { kind: "direct", policy }, participants: [] });
        runtime.getSpaceCell(social, undefined, roomTx).key("defaultPattern")
          .set(room);
        runtime.prepareTxForCommit(roomTx);
        expect((await roomTx.commit().settled).error).toBeUndefined();
        const seedTx = runtime.edit();
        const counterpart =
          (await Identity.fromPassphrase("retained direct counterpart")).did();
        const direct = {
          [counterpart]: {
            room,
            kind: "direct",
            counterpart,
            since: new FabricEpochNsec(1000n),
          },
        };
        const requests = {
          refused: {
            status: "refused",
            reason: "Two profiles share an inbox.",
            code: "shared-inbox",
          },
        };
        const notices = [{ id: "queued notice", room, recipient: counterpart }];
        const manager = home.key("chatManager");
        // `requests` is a direct argument binding, while the public notice list
        // is a computed copy. Seed the manager's actual notice argument.
        const requestStorage = manager.key("requests").resolveAsCell();
        const managerArgument = runtime.getCellFromLink({
          ...requestStorage.getAsNormalizedFullLink(),
          path: [],
        });
        expect(
          manager.key("direct").resolveAsCell().equalLinks(
            managerArgument.key("direct"),
          ),
        ).toBe(true);
        manager.withTx(seedTx).key("requests").set(requests);
        manager.withTx(seedTx).key("direct").set(direct);
        managerArgument.withTx(seedTx).key("outgoingNotices").set(notices);
        home.withTx(seedTx).key("favorites").set([{
          cell: room,
          tags: ["fabrichat-room"],
          userTags: ["retained"],
          spaceName: "Saved chat",
        }]);
        home.withTx(seedTx).key("journal").set([{
          timestamp: 1000,
          narrative: "Retained journal entry",
        }]);
        home.withTx(seedTx).key("spaces").set([{
          name: "Saved chat",
          did: social,
        }]);
        home.withTx(seedTx).key("registerSharedSpace").send({
          space: social,
          host: apiUrl.origin,
          kind: "fabrichat-room",
          title: "Saved chat",
          since: 1000,
          offer: { from: counterpart, id: "retained offer" },
        });
        runtime.prepareTxForCommit(seedTx);
        expect((await seedTx.commit().settled).error).toBeUndefined();
        await runtime.idle();
        await home.pull();
        const fields = ["requests", "direct", "outgoingNotices"] as const;
        const storedFields = async (reader: Runtime, root: Cell<unknown>) =>
          await Promise.all(fields.map(async (field) => {
            const requests = root.key("chatManager").key("requests")
              .resolveAsCell();
            const argument = reader.getCellFromLink({
              ...requests.getAsNormalizedFullLink(),
              path: [],
            });
            const stored = argument.key(field).resolveAsCell();
            await stored.sync();
            const { space, id, path } = stored.getAsNormalizedFullLink();
            return { address: { space, id, path }, value: stored.getRaw() };
          }));
        const ownedFields = async (reader: Runtime, root: Cell<unknown>) => {
          const values = await Promise.all(
            ["favorites", "journal", "spaces"].map(async (field) => {
              const stored = root.key(field).resolveAsCell();
              await stored.sync();
              const { space, id, path } = stored.getAsNormalizedFullLink();
              return { address: { space, id, path }, value: stored.getRaw() };
            }),
          );
          const catalog = reader.getCellFromLink(
            getDerivedInternalCellLink(root, {
              partialCause: "sharedSpaceCatalog",
            }),
          );
          await catalog.sync();
          const { space, id, path } = catalog.getAsNormalizedFullLink();
          const owned = [...values, {
            address: { space, id, path },
            value: catalog.getRaw(),
          }];
          for (const field of ["privateInbox", "retainedPrivateInboxes"]) {
            const stored = root.key(field).resolveAsCell();
            await stored.sync();
            const { space, id, path } = stored.getAsNormalizedFullLink();
            owned.push({
              address: { space, id, path },
              value: stored.getRaw(),
            });
          }
          if (hasInboxRequests) {
            const requests = reader.getCellFromLink(
              getDerivedInternalCellLink(root, {
                partialCause: "privateInboxRequests",
              }),
            );
            await requests.sync();
            const { space, id, path } = requests.getAsNormalizedFullLink();
            owned.push({
              address: { space, id, path },
              value: requests.getRaw(),
            });
            const spot = reader.getCellFromLink(
              getDerivedInternalCellLink(root, {
                partialCause: deepFreeze({ $generated: 4 }),
              }),
            );
            await spot.sync();
            const answering = spot.resolveAsCell();
            const { space: answerSpace, id: answerId, path: answerPath } =
              answering.getAsNormalizedFullLink();
            const answers = await answering.key("answers").pull();
            expect(answers).toMatchObject({
              profiles: {
                [Object.keys(retainedRequest)[0]]: { status: "ensured" },
              },
            });
            owned.push({
              address: { space: answerSpace, id: answerId, path: answerPath },
              value: answers,
            });
          }
          return owned;
        };
        const flatBindings = async (root: Cell<unknown>) =>
          await Promise.all([
            "registerSharedSpace",
            "changeSharedSpaceMembership",
            "removeSharedSpace",
            "sharedSpaceCatalog",
          ].map(async (name) => {
            const field = root.key(name);
            await field.pull();
            const { space, id, path } = field.resolveAsCell()
              .getAsNormalizedFullLink();
            return {
              name,
              pointer: (() => {
                // The older fixture's catalog computed uses cause 6; the
                // inbox-request fixture and current Home use cause 7. Both
                // pin the catalog target, and the latter pins its spot too.
                if (name === "sharedSpaceCatalog" && !hasInboxRequests) return;
                const link = parseLink(
                  field.getRaw(),
                  root.getAsNormalizedFullLink(),
                );
                expect(link).toBeDefined();
                return { space: link!.space, id: link!.id, path: link!.path };
              })(),
              address: name === "sharedSpaceCatalog"
                ? undefined
                : { space, id, path },
            };
          }));
        const noticeRecords = async (root: Cell<unknown>) => {
          const items = await root.key("chatManager").key("outgoingNotices")
            .asSchema<{ id: string; recipient: string; room: Cell<unknown> }[]>(
              {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    recipient: { type: "string" },
                    room: { asCell: ["cell"] },
                  },
                  required: ["id", "recipient", "room"],
                },
              },
            ).pull();
          return items.map((notice) => {
            const { space, id, path } = notice.room.resolveAsCell()
              .getAsNormalizedFullLink();
            return {
              id: notice.id,
              recipient: notice.recipient,
              room: { space, id, path },
            };
          });
        };
        const ownedBefore = await ownedFields(runtime, home);
        const flatBefore = await flatBindings(home);
        for (const field of ownedBefore.slice(0, 3)) {
          expect(field.value).toHaveLength(1);
        }
        expect(ownedBefore[3].value).toMatchObject({
          entries: { [social]: { title: "Saved chat", state: "saved" } },
          offers: {
            [JSON.stringify([counterpart, "retained offer"])]: {
              from: counterpart,
              id: "retained offer",
              space: social,
            },
          },
        });
        if (hasInboxRequests) {
          expect(ownedBefore[6].value).toEqual(retainedRequest);
        }
        // Raw stored snapshots retain complete data and serialized room links;
        // a projected query result can lazily change as the source rolls.
        const before = await storedFields(runtime, home);
        expect(before[0].value).toMatchObject(requests);
        expect(before[1].value).toHaveProperty(counterpart);
        expect(before[2].value).toHaveLength(1);
        expect(await manager.key("outgoingNotices").pull()).toHaveLength(1);
        const noticesBefore = await noticeRecords(home);
        expect(noticesBefore).toEqual([{
          id: "queued notice",
          recipient: counterpart,
          room: {
            space: social,
            id: room.getAsNormalizedFullLink().id,
            path: [],
          },
        }]);
        // A child whose position in Home shifts is set up on the stored state of
        // the child that held that position, and drops the slots its argument
        // schema refuses. The field comparisons below cover the manager and
        // Home's own state, not each child's, so the update must drop none.
        const droppedBefore = droppedSlots();
        const identity = getPatternIdentityRef(home)?.identity;
        const rootLink = home.getAsNormalizedFullLink();
        if (mode === "explicit") {
          const piece = await controller.get(rootLink.id);
          await piece.setPattern(candidate);
        } else {
          // A fresh route instance models a release replacing its source cache.
          // Home follows its origin through the ordinary open path.
          if (update) route = new PatternsRoute(patterns);
          if (mode === "automatic-cold") {
            await runtime.idle();
            await storage.synced();
            await controller.dispose();
            await runtime.dispose();
            await storage.close();
            storage = EmulatedStorageManager.connectTo(server, { as: owner });
            runtime = new Runtime({ apiUrl, storageManager: storage });
            controller = new PiecesController(
              createSession({ identity: owner, spaceDid: owner.did() }),
              runtime,
            );
          }
          await controller.ensureDefaultPattern();
        }
        await runtime.idle();
        const rolled = (await controller.getDefaultPattern(false))!;
        await rolled.pull();
        expect(rolled.equalLinks(home)).toBe(true);
        if (update) {
          expect(getPatternIdentityRef(rolled)?.identity).not.toBe(identity);
          expect(
            await rolled.key("sharedSpaces").key("view").key("status").pull(),
          )
            .toBe("ready");
          expect(
            await rolled.key("sharedSpaces").key("view").key("entries")
              .key(social).key("title").pull(),
          ).toBe("Saved chat");
        } else {
          expect(getPatternIdentityRef(rolled)?.identity).toBe(identity);
        }
        const after = await storedFields(runtime, rolled);
        if (update) expect(after).toEqual(before);
        else {
          expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
          expect(await noticeRecords(rolled)).toEqual(noticesBefore);
        }
        expect(await ownedFields(runtime, rolled)).toEqual(ownedBefore);
        expect(await rolled.key("sharedSpaceCatalog").pull()).toEqual(
          ownedBefore[3].value,
        );
        expect(await flatBindings(rolled)).toEqual(flatBefore);
        expect(droppedSlots()).toBe(droppedBefore);
        if (mode !== "explicit") {
          expect(getPatternSource(rolled)).toBe("system:system/home.tsx");
          expect(getPatternIdentityRef(rolled)?.identity).toBe(
            await route.identity("system/home.tsx"),
          );
        }
        const links = await rolled.key("chatManager").key("direct").key(
          counterpart,
        ).key("room").asSchema<Cell<unknown>>({ asCell: ["cell"] }).pull();
        expect(links?.equalLinks(room)).toBe(true);
        await runtime.idle();
        await storage.synced();
        const peerStorage = EmulatedStorageManager.connectTo(server, {
          as: owner,
        });
        const peer = new Runtime({
          apiUrl,
          storageManager: peerStorage,
        });
        const peerController = new PiecesController(
          createSession({ identity: owner, spaceDid: owner.did() }),
          peer,
        );
        try {
          const reopened = mode === "explicit"
            ? await peer.getCellFromLink(rootLink).sync()
            : (await peerController.ensureDefaultPattern()).getCell();
          expect(await peer.start(reopened)).toBe(true);
          await peer.idle();
          await reopened.pull();
          const reopenedFields = await storedFields(peer, reopened);
          // A normal Home open can materialize the notice array in a cell
          // and rebase its element links. Requests and direct bindings keep
          // their addresses; the queued notice content and room stay intact.
          expect(reopenedFields.slice(0, 2)).toEqual(before.slice(0, 2));
          if (!update) {
            expect(reopenedFields[2].address).not.toEqual(before[2].address);
          }
          expect(await noticeRecords(reopened)).toEqual(noticesBefore);
          expect(await ownedFields(peer, reopened)).toEqual(ownedBefore);
          expect(await reopened.key("sharedSpaceCatalog").pull()).toEqual(
            ownedBefore[3].value,
          );
          expect(await flatBindings(reopened)).toEqual(flatBefore);
          expect(droppedSlots()).toBe(droppedBefore);
        } finally {
          await peerController.dispose();
          await peer.dispose();
          await peerStorage.close();
        }
      } finally {
        await controller.dispose();
        await runtime.dispose();
        await storage.close();
        await server.close();
        await http.shutdown();
        await Deno.remove(temporary, { recursive: true });
      }
    });
  }
});
