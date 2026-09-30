/** Tests FabriChat provisioning and departure against an enforced memory server. */
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
import { stuckNet } from "@commonfabric/test-support/stuck-net";

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
  constructor(server: MemoryServer.Server) {
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
    super({ as: creator, memoryHost: new URL("memory://") }, factory);
  }
}

/** Finds the actual rendered departure stream without changing its bindings. */
function findLeaveControl(value: unknown): Cell<unknown> | undefined {
  if (isCell(value)) return findLeaveControl(value.get());
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findLeaveControl(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const node = value as { name?: string; children?: unknown; props?: unknown };
  const children = isCell(node.children) ? node.children.get() : node.children;
  if (
    node.name === "cf-button" && Array.isArray(children) &&
    children.includes("Leave conversation")
  ) {
    const props = isCell(node.props) ? node.props.get() : node.props;
    return (props as { onClick: Cell<unknown> }).onClick;
  }
  return findLeaveControl(children);
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
      const member = (await Identity.fromPassphrase("chat-manager-member"))
        .did();
      const send = async (status: string, requestId = "create-1") => {
        const event = {
          requestId,
          title: "A private group",
          members: [member, member],
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
      const profileSpace = await runtime.resolvePrivateSpace(
        "test-profile",
        creator.did(),
      );
      const profileTx = runtime.edit();
      const profile = runtime.getCell(
        profileSpace,
        "test-profile",
        undefined,
        profileTx,
      );
      profile.set({ name: "Creator" });
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
      const placementProgram = await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        { main: join(root, "fabrichat", "placement.tsx"), root },
      );
      const placementPattern = await runtime.patternManager.compilePattern(
        placementProgram,
      );
      const container = await runtime.resolvePrivateSpace(
        "direct-container",
        creator.did(),
      );
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
      const extra = (await Identity.fromPassphrase("chat-extra-member")).did();
      const membership = async (
        stream: string,
        payload: Record<string, unknown>,
        count: number,
      ) => {
        const event = {
          ...payload,
          provenance: {
            origin: "dom",
            trusted: true,
            ui: {
              pattern: "ChatMembersSurface",
              eventIntegrity: ["ChatMembersSurface"],
              uiContractDataset: { uiAction: "ChatMembers" },
            },
          },
        };
        markRendererTrustedEvent(event);
        await room.key(stream).send(event);
        await waitForCellValue<unknown[]>(
          runtime,
          room.key("recentActivity"),
          (value) => value?.length === count,
        );
        await manager.synced();
        const publicActivity = room.key("recentActivity").key(count - 1)
          .resolveAsCell();
        const claims = cfcLabelViewForCell(publicActivity)?.entries.flatMap((
          entry,
        ) => entry.label.integrity ?? []);
        expect(claims).toContainEqual({
          kind: "authored-by",
          subject: creator.did(),
        });
      };
      await membership("add", {
        requestId: "add-extra",
        principal: extra,
        access: "WRITE",
      }, 1);
      await membership("remove", {
        requestId: "remove-original",
        principal: member,
      }, 2);
      await membership("add", {
        requestId: "re-add-original",
        principal: member,
        access: "WRITE",
      }, 3);
      const ui = room.key(UI);
      await ui.pull();
      const leaveControl = findLeaveControl(ui);
      expect(leaveControl).toBeDefined();
      const replica = manager.open(roomSpace).replica as unknown as {
        commitNative: (...args: unknown[]) => unknown;
      };
      const originalCommit = replica.commitNative;
      let rejected = false;
      replica.commitNative = function (...args: unknown[]) {
        if ((args[0] as { aclChange?: unknown }).aclChange) {
          rejected = true;
          return Promise.resolve({
            error: new Error("Injected leave refusal"),
          });
        }
        return Reflect.apply(originalCommit, this, args);
      };
      try {
        await leaveControl!.send(undefined);
        await runtime.idle();
      } finally {
        replica.commitNative = originalCommit;
      }
      expect(rejected).toBe(true);
      await result.key("rooms").pull();
      expect(result.key("rooms").get()).toHaveLength(2);
      expect((await new ACLManager(runtime, roomSpace).get())?.[creator.did()])
        .toBe("OWNER");
      const forgotten = Promise.withResolvers<void>();
      const stuck = stuckNet(
        "leaving a FabriChat room removes its private index entry",
      );
      const stopWatching = result.key("rooms").sink((value) => {
        if (Array.isArray(value) && value.length === 1) forgotten.resolve();
      });
      try {
        await leaveControl!.send(undefined);
        await Promise.race([forgotten.promise, stuck.rejects]);
        await manager.synced();
        expect(result.key("rooms").get()).toHaveLength(1);
      } finally {
        stuck.clear();
        stopWatching();
      }
      const remaining = await MemoryClient.connect({
        transport: MemoryClient.loopback(server),
      });
      const remainingSession = await remaining.mount(
        roomSpace,
        {},
        testPrincipalSessionOpenAuthFactory(
          await Identity.fromPassphrase("chat-manager-member"),
        ),
      );
      const remainingAcl = await remainingSession.queryGraph({
        roots: [{
          id: `of:${roomSpace}`,
          selector: { path: [], schema: false },
        }],
      });
      expect(remainingAcl.entities[0]?.document?.value).toEqual({
        [member]: "WRITE",
        [extra]: "OWNER",
      });
      await remaining.close();
    } finally {
      await runtime.dispose();
      await manager.close();
      await server.close();
    }
  });
});
