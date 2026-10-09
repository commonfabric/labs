/**
 * Who gets a space root created by asking for one. Each case drives a real
 * `RuntimeClient` over a `MessageChannel` to a real processor, whose runtime
 * acts as one principal over an in-process memory server enforcing access
 * lists, and reads what that server holds before and after.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";
import type { ACL } from "@commonfabric/memory/acl";
import type { MemorySpace } from "@commonfabric/memory/interface";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import {
  ACLManager,
  resolveEntryIdentity,
  Runtime,
} from "@commonfabric/runner";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { RuntimeProcessor } from "@/backends/mod.ts";
import { RuntimeClients } from "@/backends/client-registry.ts";
import { MessagePortRuntimeTransport } from "@/client/transports/message-port/transport-message-port.ts";
import { RequestType } from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";
import { buildProcessor } from "./backends/build-processor.ts";

const owner = await Identity.fromPassphrase("space-root-open owner", {
  implementation: "noble",
});
const visitor = await Identity.fromPassphrase("space-root-open visitor", {
  implementation: "noble",
});
// What `buildProcessor()` runs the processor under, which the client asserts.
const apiUrl = "http://localhost/";

/** The route the system default app is served from. */
const defaultAppRoute = "/api/patterns/system/default-app.tsx";

/** What the route serves: a default app that exports one value. */
const defaultAppSource = `
  import { pattern } from "commonfabric";
  export default pattern(() => ({ stand: "default app" }));
`;

const defaultAppIdentity = await resolveEntryIdentity(
  defaultAppRoute,
  () => Promise.resolve(defaultAppSource),
);

/** A client attached over a channel to a processor serving `runtime`. */
async function attachClient(
  runtime: Runtime,
  identity: Identity,
): Promise<RuntimeClient> {
  const clients = new RuntimeClients({
    setConsoleBridge: () => {},
    owner: { id: 0, post: () => true },
    initializeRuntime: () =>
      Promise.resolve(
        buildProcessor({
          runtime,
          identity,
          space: identity.did(),
        }) as unknown as RuntimeProcessor,
      ),
  });
  await clients.handleMessage(
    clients.owner,
    new MessageEvent("message", {
      data: realmFromFabricValue({
        msgId: 1,
        data: {
          type: RequestType.Initialize,
          data: {
            apiUrl,
            identity: { placeholder: true },
            spaceDid: identity.did(),
          },
        },
      } as never),
    }),
  );
  const channel = new MessageChannel();
  clients.attach(channel.port2);
  return await RuntimeClient.attach(
    new MessagePortRuntimeTransport({ port: channel.port1 }),
    {
      apiUrl: new URL(apiUrl),
      identity: identity.did(),
      spaceDid: identity.did(),
    },
  );
}

/**
 * A memory server enforcing access lists, holding a space the owner created
 * with no root that grants `grants` beside the owner's `OWNER`, and a client
 * for each of the owner and a visitor. The grants default to everyone
 * `WRITE`. The default app's route is served in-process, and every request
 * for it is recorded.
 */
async function rootlessSpace(grants: ACL = { "*": "WRITE" }) {
  const server = new MemoryV2Server.Server({
    authorizeSessionOpen: authorizeLoopbackSessionOpen,
    sessionOpenAuth: { audience: "did:key:z6Mk-space-root-open" },
    acl: { mode: "enforce" },
    subscriptionRefreshDelayMs: 0,
  });
  const fetched: string[] = [];
  const fetchStub = stub(
    globalThis,
    "fetch",
    (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      fetched.push(url.pathname);
      const served = url.pathname === defaultAppRoute;
      return Promise.resolve(
        new Response(
          !served
            ? "not found"
            : url.searchParams.has("identity")
            ? defaultAppIdentity
            : defaultAppSource,
          { status: served ? 200 : 404 },
        ),
      );
    },
  );
  const parties = await Promise.all([owner, visitor].map(async (identity) => {
    const storage = EmulatedStorageManager.connectTo(server, { as: identity });
    const runtime = new Runtime({
      apiUrl: new URL(apiUrl),
      storageManager: storage,
    });
    return { storage, runtime, client: await attachClient(runtime, identity) };
  }));
  const [ownerParty, visitorParty] = parties;
  const space: MemorySpace = await ownerParty.runtime.createSpace({
    grants,
  });
  const spaceCellId = ownerParty.runtime.getSpaceCell(space)
    .getAsNormalizedFullLink().id;

  return {
    space,
    owner: ownerParty.client,
    visitor: visitorParty.client,
    fetched,

    /**
     * Removes the visitor's entry from the space's access list, and resolves
     * once the visitor's storage has heard that it lost the space.
     */
    revokeVisitor: async () => {
      const lost = Promise.withResolvers<void>();
      const cancel = visitorParty.storage.subscribeSpaceAccessLoss(
        (lostSpace) => {
          if (lostSpace === space) lost.resolve();
        },
      );
      try {
        await new ACLManager(ownerParty.runtime, space).remove(visitor.did());
        await lost.promise;
      } finally {
        cancel();
      }
    },

    /** Whether a space answers to `did`, asked as the owner. */
    spaceExists: (did: MemorySpace) => ownerParty.runtime.spaceExists(did),

    /** The space cell, as the memory server holds it. */
    storedSpaceCell: async () => {
      for (const { runtime, storage } of parties) {
        await runtime.idle();
        await storage.synced();
      }
      return (await server.readDocument(space, spaceCellId))?.value;
    },

    [Symbol.asyncDispose]: async () => {
      for (const { client, runtime, storage } of parties) {
        await client.dispose();
        await runtime.dispose();
        await storage.close();
      }
      await server.close();
      fetchStub.restore();
    },
  };
}

describe("space-root-open", () => {
  describe("a visitor holding `WRITE`", () => {
    it("reads no root, and writes none, when `start` is `false`", async () => {
      await using room = await rootlessSpace();
      expect(await room.storedSpaceCell()).toBeUndefined();

      const root = await room.visitor.getSpaceRootPattern(room.space, {
        start: false,
      });

      expect(root).toBeUndefined();
      expect(await room.storedSpaceCell()).toBeUndefined();
      expect(room.fetched).toEqual([]);
    });

    it("opens no root, and writes none, when `start` is `true`", async () => {
      await using room = await rootlessSpace();
      expect(await room.storedSpaceCell()).toBeUndefined();

      const root = await room.visitor.getSpaceRootPattern(room.space);

      expect(root).toBeUndefined();
      expect(await room.storedSpaceCell()).toBeUndefined();
      expect(room.fetched).toEqual([]);
    });

    it("opens the root once the owner has created it", async () => {
      await using room = await rootlessSpace();
      const created = await room.owner.getSpaceRootPattern(room.space);

      const opened = await room.visitor.getSpaceRootPattern(room.space);

      expect(opened?.id()).toBe(created?.id());
    });
  });

  describe("a visitor whose access is revoked", () => {
    it("is refused a root it was handed before, whatever `start` is", async () => {
      await using room = await rootlessSpace({ [visitor.did()]: "READ" });
      await room.owner.getSpaceRootPattern(room.space);
      expect(await room.visitor.getSpaceRootPattern(room.space)).toBeDefined();

      await room.revokeVisitor();

      for (const start of [false, true]) {
        await expect(room.visitor.getSpaceRootPattern(room.space, { start }))
          .rejects.toThrow("memory session revoked: unauthorized");
      }
    });
  });

  describe("a principal the space does not admit", () => {
    it("is refused, and writes nothing, whatever `start` is", async () => {
      await using room = await rootlessSpace({});

      for (const start of [false, true]) {
        await expect(room.visitor.getSpaceRootPattern(room.space, { start }))
          .rejects.toThrow("lacks READ");
      }
      expect(await room.storedSpaceCell()).toBeUndefined();
      expect(room.fetched).toEqual([]);
    });
  });

  describe("a DID no space answers to", () => {
    it("is not found on opening, and is not created", async () => {
      await using room = await rootlessSpace();
      const nobody = (await Identity.generate({ implementation: "noble" }))
        .did();

      await expect(room.visitor.getSpaceRootPattern(nobody))
        .rejects.toThrow(`No space answers to ${nobody}`);
      expect(await room.spaceExists(nobody)).toBe(false);
      expect(room.fetched).toEqual([]);
    });
  });

  describe("the owner", () => {
    it("creates the root on opening a space that has none", async () => {
      await using room = await rootlessSpace();
      expect(await room.storedSpaceCell()).toBeUndefined();

      const root = await room.owner.getSpaceRootPattern(room.space);

      expect(root).toBeDefined();
      expect(room.fetched).toContain(defaultAppRoute);
      const stored = await room.storedSpaceCell() as
        | Record<string, unknown>
        | undefined;
      expect(stored?.defaultPattern).toBeDefined();
    });

    it("reads no root, and writes none, when `start` is `false`", async () => {
      await using room = await rootlessSpace();

      const root = await room.owner.getSpaceRootPattern(room.space, {
        start: false,
      });

      expect(root).toBeUndefined();
      expect(await room.storedSpaceCell()).toBeUndefined();
      expect(room.fetched).toEqual([]);
    });
  });
});
