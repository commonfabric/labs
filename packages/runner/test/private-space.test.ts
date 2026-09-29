import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { join } from "@std/path";
import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import { resolveLocalProgram } from "../src/harness/local-program.deno.ts";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { ACLManager } from "../src/acl-manager.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import * as MemoryServer from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import { type SessionFactory, StorageManager } from "../src/storage/v2.ts";
import { testPrincipalSessionOpenAuthFactory } from "./memory-v2-test-utils.ts";

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

const creator = await Identity.fromPassphrase("private-space-creator");

describe("private-space", () => {
  it("creates a random creator-only space and converges concurrent allocation attempts", async () => {
    const server = new MemoryServer.Server({
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:private-space-test" },
      acl: { mode: "enforce" },
    });
    const storageManager = new PrivateStorageManager(server);
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const [first, repeated] = await Promise.all([
        runtime.resolvePrivateSpace("allocation-a", creator.did()),
        runtime.resolvePrivateSpace("allocation-a", creator.did()),
      ]);
      expect(first).toBe(repeated);
      expect(await new ACLManager(runtime, first).get()).toEqual({
        [creator.did()]: "OWNER",
      });
      const second = await runtime.resolvePrivateSpace(
        "allocation-b",
        creator.did(),
      );
      expect(second).not.toBe(first);
      expect(second).not.toBe(creator.did());
      expect(await new ACLManager(runtime, second).get()).toEqual({
        [creator.did()]: "OWNER",
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
      await server.close();
    }
  });
  it("reuses a durable private allocation across compiled pattern handler invocations", async () => {
    const server = new MemoryServer.Server({
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:private-space-test" },
      acl: { mode: "enforce" },
    });
    const manager = new PrivateStorageManager(server);
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: manager,
    });
    try {
      const { main } = await runtime.harness.compileAndEvaluateModules({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
          import { Cell, handler, pattern, spaceMembers, setSpaceMembers, currentPrincipal, Writable } from "commonfabric";
          const grant = handler<{ principal: string }, { revision: Writable<number> }>((event, { revision }) => {
            setSpaceMembers({ ...spaceMembers(), [event.principal]: "WRITE" });
            revision.set(revision.get() + 1);
          });
          const child = pattern(() => {
            const revision = new Writable(0);
            return { value: "private", revision, grant: grant({ revision }) };
          });
          const create = handler<void, { selected: Writable<Cell<{ value: string }> | undefined> }>((_, { selected }) => {
            selected.set(child.inPrivateSpace("test-room")({}));
          });
          export default pattern(() => {
            const selected = new Writable<Cell<{ value: string }> | undefined>();
            return { selected, create: create({ selected }) };
          });
        `,
        }],
      });
      const resultCell = runtime.getCell<Record<string, unknown>>(
        creator.did(),
        "private-parent",
      );
      const result = await runtime.runSynced(resultCell, main!.default, {});
      await result.key("create").send(undefined);
      await runtime.idle();
      await result.pull();
      const selected = result.key("selected").resolveAsCell();
      const link = selected.getAsNormalizedFullLink();
      expect(link.space).not.toBe(creator.did());
      expect(selected.key("value").get()).toBe("private");
      expect(await new ACLManager(runtime, link.space).get()).toEqual({
        [creator.did()]: "OWNER",
      });
      const invited = await Identity.fromPassphrase("private-space-invited");
      await selected.key("grant").send({ principal: invited.did() });
      await runtime.idle();
      expect(selected.key("revision").get()).toBe(1);
      const observer = await MemoryClient.connect({
        transport: MemoryClient.loopback(server),
      });
      const observerSession = await observer.mount(
        link.space,
        {},
        testPrincipalSessionOpenAuthFactory(creator),
      );
      const acl = await observerSession.queryGraph({
        roots: [{
          id: `of:${link.space}`,
          selector: { path: [], schema: false },
        }],
      });
      await observer.close();
      expect(acl.entities[0]?.document?.value).toEqual({
        [creator.did()]: "OWNER",
        [invited.did()]: "WRITE",
      });
      await result.key("create").send(undefined);
      await runtime.idle();
      expect(
        result.key("selected").resolveAsCell().getAsNormalizedFullLink().space,
      ).toBe(link.space);
    } finally {
      await runtime.dispose();
      await manager.close();
      await server.close();
    }
  });
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
      const root = join(import.meta.dirname!, "..", "..", "patterns");
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
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await result.pull();
      const member = (await Identity.fromPassphrase("chat-manager-member"))
        .did();
      const send = async (status: string) => {
        const event = {
          requestId: "create-1",
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
          result.key("requests").key("create-1").key("status"),
          (value) => value === status,
        );
        await manager.synced();
        await result.pull();
      };
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
      expect(policy.key("proposedTimeMaxAgeNsec").get()).toBe(600_000_000_000n);
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
      await room.key("leave").send({ requestId: "leave-creator" });
      await runtime.idle();
      await manager.synced();
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
