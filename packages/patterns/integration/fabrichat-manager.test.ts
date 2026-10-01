/** Tests FabriChat provisioning and system-owned spaces against enforced memory. */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import * as MemoryServer from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import {
  ACLManager,
  type Cell,
  isCell,
  Runtime,
  UI,
  VIEWS,
} from "@commonfabric/runner";
import {
  cfcLabelViewForCell,
  markRendererTrustedEvent,
} from "@commonfabric/runner/cfc";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  type SessionFactory,
  StorageManager,
} from "@commonfabric/runner/storage/v2";

/** Supplies the explicit principal expected by the in-process loopback server. */
function testPrincipalSessionOpenAuthFactory(
  signer?: Signer,
): MemoryClient.SessionOpenAuthFactory {
  return (_space, _session, context) => ({
    invocation: { aud: context.audience, challenge: context.challenge.value },
    authorization: { principal: signer?.did() },
  });
}

class PrivateStorageManager extends StorageManager {
  constructor(server: MemoryServer.Server, identity: Identity = creator) {
    const factory: SessionFactory = {
      supportsAclBootstrap: true,
      async create(
        space: MemorySpace,
        signer?: Signer,
        options: MemoryClient.MountOptions = {},
      ) {
        const client = await MemoryClient.connect({
          transport: MemoryClient.loopback(server),
        });
        const session = await client.mount(
          space,
          options,
          testPrincipalSessionOpenAuthFactory(signer),
        );
        return { client, session };
      },
    };
    super({ as: identity, memoryHost: new URL("memory://") }, factory);
  }
}

/** Finds the live start control without replacing its handler bindings. */
function findStartControl(value: unknown): Cell<unknown> | undefined {
  if (isCell(value)) return findStartControl(value.get());
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findStartControl(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const node = value as { name?: string; children?: unknown; props?: unknown };
  const children = isCell(node.children) ? node.children.get() : node.children;
  if (
    node.name === "cf-button" && Array.isArray(children) &&
    children.includes("Start conversation")
  ) {
    const props = isCell(node.props) ? node.props.get() : node.props;
    return (props as { onClick: Cell<unknown> }).onClick;
  }
  return findStartControl(children);
}

const creator = await Identity.fromPassphrase("private-space-creator");

describe("FabriChat manager", () => {
  it("resumes a FabriChat creation and publishes its private room only after granting members", async () => {
    const server = new MemoryServer.Server({
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:private-manager-test" },
      acl: { mode: "enforce" },
    });
    const manager = new PrivateStorageManager(server);
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: manager,
    });
    try {
      const root = join(import.meta.dirname!, "..");
      const program = await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        { main: join(root, "fabrichat", "manager.tsx"), root },
      );
      const tx = runtime.edit();
      const pattern = await runtime.patternManager.compilePattern(program, {
        space: creator.did(),
        tx,
      });
      const result = runtime.getCell<Record<string, unknown>>(
        creator.did(),
        "chat-manager-test",
        pattern.resultSchema,
        tx,
      );
      runtime.run(tx, pattern, {}, result);
      const home = runtime.getCell(
        creator.did(),
        "chat-test-home",
        undefined,
        tx,
      );
      home.set({ chatManager: result });
      runtime.getHomeSpaceCell(tx).key("defaultPattern").set(home);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await result.pull();
      const memberIdentity = await Identity.fromPassphrase(
        "chat-manager-member",
      );
      const member = memberIdentity.did();
      const send = async (
        status: string,
        requestId = "create-1",
        members: string[] = [member, member],
      ) => {
        const event = {
          requestId,
          title: "A private group",
          members,
          provenance: {
            origin: "dom",
            trusted: true,
            ui: {
              pattern: "ChatStartSurface",
              eventIntegrity: ["ChatStartSurface"],
              uiContractDataset: { uiAction: "ChatStart" },
            },
          },
        };
        markRendererTrustedEvent(event);
        await result.key("createGroup").send(event);
        await waitForCellValue(
          runtime,
          result.key("requests").key(requestId).key("status"),
          (value) => value === status,
        );
        await manager.synced();
        await result.pull();
      };
      await send("refused", "without-profile");
      expect(result.key("rooms").get()).toHaveLength(0);
      expect(result.key("outgoingNotices").get()).toHaveLength(0);
      const profileSpace = await manager.createSpace({
        [creator.did()]: "OWNER",
      });
      const profileTx = runtime.edit();
      const profile = runtime.getCell(
        profileSpace,
        "test-profile",
        {
          type: "object",
          properties: { name: { type: "string" } },
          ifc: { addIntegrity: ["fabrichat-test-profile"] },
        },
        profileTx,
      );
      profile.set({ name: "Creator" });
      runtime.prepareTxForCommit(profileTx);
      expect((await profileTx.commit()).error).toBeUndefined();
      const homeTx = runtime.edit();
      home.withTx(homeTx).set({
        chatManager: result,
        profiles: [profile],
        defaultProfile: profile,
      });
      expect((await homeTx.commit()).error).toBeUndefined();
      await runtime.idle();
      await result.pull();
      await send("refused", "without-profile");
      await send("refused", "invalid-member", ["did:"]);
      expect(result.key("rooms").get()).toHaveLength(0);
      expect(result.key("outgoingNotices").get()).toHaveLength(0);
      await send("done");
      expect(result.key("requests").key("create-1").key("status").get()).toBe(
        "done",
      );
      await result.key("rooms").resolveAsCell().pull();
      expect(result.key("rooms").get()).toHaveLength(1);
      expect(result.key("outgoingNotices").get()).toHaveLength(1);
      const room = result.key("rooms").key(0).key("room").resolveAsCell();
      const roomSpace = room.getAsNormalizedFullLink().space;
      expect(roomSpace).not.toBe(creator.did());
      expect(
        runtime.getSpaceCell(roomSpace).key("chat").resolveAsCell().equals(
          room,
        ),
      )
        .toBe(true);
      expect(runtime.getSpaceCell(roomSpace).key("defaultPattern").getRaw())
        .toBeUndefined();
      const about = room.key("about").resolveAsCell();
      const policy = about.key("policy").resolveAsCell();
      expect(policy.getAsNormalizedFullLink().space).toBe(roomSpace);
      expect(policy.getAsNormalizedFullLink().id).not.toBe(
        about.getAsNormalizedFullLink().id,
      );
      const maxAge = policy.key("proposedTimeMaxAgeNsec").get();
      expect(maxAge.schemaType).toBe("FabricDurationNsec");
      expect(maxAge.value).toBe(600_000_000_000n);
      for (const record of [about, policy]) {
        const label = cfcLabelViewForCell(record);
        expect(label?.entries.flatMap((entry) => entry.label.integrity ?? []))
          .toContainEqual({ kind: "authored-by", subject: creator.did() });
      }
      const observer = await MemoryClient.connect({
        transport: MemoryClient.loopback(server),
      });
      const session = await observer.mount(
        roomSpace,
        {},
        testPrincipalSessionOpenAuthFactory(creator),
      );
      const acl = await session.queryGraph({
        roots: [{
          id: `of:${roomSpace}`,
          selector: { path: [], schema: false },
        }],
      });
      expect(acl.entities[0]?.document?.value).toEqual({
        [creator.did()]: "OWNER",
        [member]: "WRITE",
      });
      await observer.close();
      await send("done");
      expect(result.key("rooms").get()).toHaveLength(1);
      const directEvent = (requestId: string) => {
        const event = {
          requestId,
          counterpart: member,
          provenance: {
            origin: "dom",
            trusted: true,
            ui: {
              pattern: "ChatStartSurface",
              eventIntegrity: ["ChatStartSurface"],
              uiContractDataset: { uiAction: "ChatStart" },
            },
          },
        };
        markRendererTrustedEvent(event);
        return event;
      };
      await Promise.all([
        result.key("openDirect").send(directEvent("direct-1")),
        result.key("openDirect").send(directEvent("direct-2")),
      ]);
      for (const id of ["direct-1", "direct-2"]) {
        await waitForCellValue(
          runtime,
          result.key("requests").key(id).key("status"),
          (value) => value === "done",
        );
      }
      await manager.synced();
      await result.pull();
      expect(result.key("rooms").get()).toHaveLength(2);
      expect(result.key("outgoingNotices").get()).toHaveLength(2);
      const direct = result.key("direct").key(member).key("room")
        .resolveAsCell();
      const directLink = direct.getAsNormalizedFullLink();
      for (const id of ["direct-1", "direct-2"]) {
        expect(
          result.key("requests").key(id).key("entry").key("room")
            .resolveAsCell().getAsNormalizedFullLink(),
        ).toEqual(directLink);
      }
      await result.key("accept").send({
        requestId: "accept-false-creator",
        room: direct,
        counterpart: member,
      });
      await waitForCellValue(
        runtime,
        result.key("requests").key("accept-false-creator").key("status"),
        (value) => value === "refused",
      );
      const recipientStorage = new PrivateStorageManager(
        server,
        memberIdentity,
      );
      const recipientRuntime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager: recipientStorage,
      });
      try {
        const recipientPattern = await recipientRuntime.patternManager
          .compilePattern(program, { space: member });
        const recipientManager = recipientRuntime.getCell<
          Record<string, unknown>
        >(
          member,
          "recipient-chat-manager",
          recipientPattern.resultSchema,
        );
        await recipientRuntime.runSynced(
          recipientManager,
          recipientPattern,
          {},
        );
        const recipientRoom = recipientRuntime.getCellFromLink(directLink);
        await recipientManager.key("accept").send({
          requestId: "accept-attested-creator",
          room: recipientRoom,
          counterpart: creator.did(),
        });
        await waitForCellValue(
          recipientRuntime,
          recipientManager.key("requests").key("accept-attested-creator")
            .key("status"),
          (value) => value === "done",
        );
        expect(
          recipientManager.key("direct").key(creator.did()).key("room")
            .resolveAsCell().equals(recipientRoom),
        ).toBe(true);
      } finally {
        await recipientRuntime.dispose();
        await recipientStorage.close();
      }
      const placementProgram = await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        { main: join(root, "fabrichat", "placement.tsx"), root },
      );
      const placementPattern = await runtime.patternManager.compilePattern(
        placementProgram,
      );
      const container = await manager.createSpace({ [creator.did()]: "OWNER" });
      const placement = runtime.getCell<Record<string, unknown>>(
        container,
        "placement",
      );
      await runtime.runSynced(placement, placementPattern, { room: direct });
      await waitForCellValue(
        runtime,
        placement.key(VIEWS).key("chat").key("state"),
        (value) => value === "member",
      );
      const outsider = (await Identity.fromPassphrase("placement-outsider"))
        .did();
      await new ACLManager(runtime, container).set(outsider, "READ");
      await waitForCellValue(
        runtime,
        placement.key(VIEWS).key("chat").key("state"),
        (value) => value === "unavailable",
      );
      expect(placement.key(VIEWS).key("chat").key("messages").get())
        .toBeUndefined();
      await new ACLManager(runtime, directLink.space).set(outsider, "READ");
      await runtime.idle();
      expect(placement.key(VIEWS).key("chat").key("state").get())
        .toBe("unavailable");
      await result.key("forget").send({ requestId: "forget-1", room: direct });
      await runtime.idle();
      expect(result.key("rooms").get()).toHaveLength(1);
      await result.key("openDirect").send(directEvent("direct-3"));
      await runtime.idle();
      expect(result.key("rooms").get()).toHaveLength(2);
      expect(
        result.key("direct").key(member).key("room").resolveAsCell()
          .getAsNormalizedFullLink(),
      ).toEqual(directLink);
      const noticeId = result.key("outgoingNotices").key(0).key("id").get();
      await result.key("delivered").send({
        requestId: "delivered-1",
        id: noticeId,
      });
      await runtime.idle();
      expect(result.key("outgoingNotices").get()).toHaveLength(1);
      expect(result.key("requests").key("delivered-1").get()).toBeUndefined();
      await result.key("delivered").send({
        requestId: "delivered-1",
        id: noticeId,
      });
      await runtime.idle();
      expect(result.key("outgoingNotices").get()).toHaveLength(1);
      await runtime.patternManager.flushCompileCacheWrites();
      await manager.synced();
      const reopenedStorage = new PrivateStorageManager(server);
      const reopenedRuntime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager: reopenedStorage,
      });
      try {
        const reopened = reopenedRuntime.getCellFromLink(
          result.getAsNormalizedFullLink(),
        );
        await reopened.sync();
        expect(await reopenedRuntime.start(reopened)).toBe(true);
        await reopened.pull();
        await reopened.key("openDirect").send(
          directEvent("direct-after-restart"),
        );
        await waitForCellValue(
          reopenedRuntime,
          reopened.key("requests").key("direct-after-restart").key("status"),
          (value) => value === "done",
        );
        expect(
          reopened.key("direct").key(member).key("room").resolveAsCell()
            .getAsNormalizedFullLink(),
        ).toEqual(directLink);
        const reopenedRooms = reopened.key("rooms").asSchema({
          type: "array",
          items: {
            type: "object",
            properties: {
              room: { type: "unknown", asCell: ["cell"] },
            },
          },
        });
        await reopenedRooms.pull();
        expect(reopenedRooms.get()).toHaveLength(2);
      } finally {
        await reopenedRuntime.dispose();
        await reopenedStorage.close();
      }
      expect(room.key("participants").get()).toEqual([]);
      for (
        const key of [
          "roster",
          "showProfile",
          "leave",
          "add",
          "remove",
          "outgoingNotices",
        ]
      ) {
        expect(room.key(key).get()).toBeUndefined();
      }

      const defaultProgram = await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        { main: join(root, "system", "default-app.tsx"), root },
      );
      const defaultPattern = await runtime.patternManager.compilePattern(
        defaultProgram,
      );
      const spaceRoot = runtime.getCell<Record<string, unknown>>(
        roomSpace,
        "system-space-root",
        defaultPattern.resultSchema,
      );
      await runtime.runSynced(spaceRoot, defaultPattern, {});
      const rootTx = runtime.edit();
      runtime.getSpaceCell(roomSpace, undefined, rootTx).key("defaultPattern")
        .set(spaceRoot);
      expect((await rootTx.commit()).error).toBeUndefined();
      const mainProgram = await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        { main: join(root, "fabrichat", "main.tsx"), root },
      );
      const mainPattern = await runtime.patternManager.compilePattern(
        mainProgram,
      );
      const reopenedChat = runtime.getCell<Record<string, unknown>>(
        roomSpace,
        "reopened-space-chat",
        mainPattern.resultSchema,
      );
      await runtime.runSynced(reopenedChat, mainPattern, {});
      await reopenedChat.key("room").pull();
      expect(reopenedChat.key("room").resolveAsCell().equals(room)).toBe(true);
      expect(
        runtime.getSpaceCell(roomSpace).key("chat").resolveAsCell().equals(
          room,
        ),
      )
        .toBe(true);

      const existingSpace = await manager.createSpace({
        [creator.did()]: "OWNER",
      });
      const firstChat = runtime.getCell<Record<string, unknown>>(
        existingSpace,
        "first-space-chat",
        mainPattern.resultSchema,
      );
      const secondChat = runtime.getCell<Record<string, unknown>>(
        existingSpace,
        "second-space-chat",
        mainPattern.resultSchema,
      );
      await runtime.runSynced(firstChat, mainPattern, {});
      await runtime.runSynced(secondChat, mainPattern, {});
      await firstChat.key(UI).pull();
      await secondChat.key(UI).pull();
      const firstStart = findStartControl(firstChat.key(UI).get());
      const secondStart = findStartControl(secondChat.key(UI).get());
      expect(firstStart).toBeDefined();
      expect(secondStart).toBeDefined();
      for (const start of [firstStart!, secondStart!]) {
        const event = {};
        markRendererTrustedEvent(event);
        await start.send(event);
      }
      await runtime.idle();
      await firstChat.key("room").pull();
      await secondChat.key("room").pull();
      expect(
        firstChat.key("room").resolveAsCell().equals(
          secondChat.key("room").resolveAsCell(),
        ),
      ).toBe(true);
      expect(firstChat.key("room").key("about").key("title").get())
        .toBeUndefined();

      const unmaterializedSpace = await manager.createSpace({
        [creator.did()]: "OWNER",
      });
      const unmaterializedStart = runtime.getCell<Record<string, unknown>>(
        unmaterializedSpace,
        "unmaterialized-start",
        mainPattern.resultSchema,
      );
      await runtime.runSynced(unmaterializedStart, mainPattern, {});
      await unmaterializedStart.key(UI).pull();
      const staleStart = findStartControl(unmaterializedStart.key(UI).get());
      expect(staleStart).toBeDefined();
      const unmaterializedRoom = runtime.getCell(
        unmaterializedSpace,
        "unmaterialized-room",
      );
      const claimTx = runtime.edit();
      runtime.getSpaceCell(unmaterializedSpace, undefined, claimTx).key("chat")
        .set(unmaterializedRoom);
      expect((await claimTx.commit()).error).toBeUndefined();
      const staleEvent = {};
      markRendererTrustedEvent(staleEvent);
      await staleStart!.send(staleEvent);
      await runtime.idle();
      expect(
        runtime.getSpaceCell(unmaterializedSpace).key("chat").resolveAsCell()
          .equals(unmaterializedRoom),
      ).toBe(true);
      expect(unmaterializedRoom.getRaw()).toBeUndefined();

      const existingRoom = firstChat.key("room").resolveAsCell();
      const existingAcl = new ACLManager(runtime, existingSpace);
      await existingAcl.set(member, "OWNER");
      await existingAcl.set("*", "READ");
      await existingAcl.remove(creator.did());
      await result.key("accept").send({
        requestId: "accept-wildcard",
        room: existingRoom,
      });
      await waitForCellValue(
        runtime,
        result.key("requests").key("accept-wildcard").key("status"),
        (value) => value === "done",
      );
      await result.key("forget").send({
        requestId: "forget-wildcard",
        room: existingRoom,
      });
      await runtime.idle();

      await spaceRoot.key("addParticipant").send({ profile });
      await waitForCellValue<Cell<unknown>[]>(
        runtime,
        room.key("participants"),
        (value) => value?.length === 1,
      );
      expect(room.key("participants").key(0).resolveAsCell().equals(profile))
        .toBe(true);
      await spaceRoot.key("addParticipant").send({ profile });
      await runtime.idle();
      expect(room.key("participants").get()).toHaveLength(1);

      // Space administration changes access without rewriting the conversation.
      const roomAcl = new ACLManager(runtime, roomSpace);
      await roomAcl.set(member, "OWNER");
      await roomAcl.remove(creator.did());
      await result.key("forget").send({ requestId: "forget-revoked", room });
      await waitForCellValue<unknown[]>(
        runtime,
        result.key("rooms"),
        (value) => value?.length === 1,
      );
    } finally {
      await runtime.dispose();
      await manager.close();
      await server.close();
    }
  });
});
