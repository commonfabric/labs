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
});
