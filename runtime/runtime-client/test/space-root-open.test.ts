/**
 * Who gets a space root created by asking for one, and the code a request
 * fails with when its space refuses the runtime or is deleted. Each case
 * drives a real
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
  entityIdFrom,
  resolveEntryIdentity,
  Runtime,
  slugIdForSpace,
} from "@commonfabric/runner";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { RuntimeProcessor } from "@/backends/mod.ts";
import { RuntimeClients } from "@/backends/client-registry.ts";
import { MessagePortRuntimeTransport } from "@/client/transports/message-port/transport-message-port.ts";
import { RequestType, RuntimeErrorCode } from "@/protocol/mod.ts";
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
const defaultAppRoute = "/api/patterns/system/default-app/default-app.tsx";

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

    /**
     * Deletes the space, as its sole member. Holds only for a space that
     * grants nobody else anything.
     */
    deleteSpace: async () => {
      await new ACLManager(ownerParty.runtime, space).delete(owner.did());
      await ownerParty.runtime.idle();
      await ownerParty.storage.synced();
    },

    /**
     * Binds `slug`, in a space of `at`'s or else the room's own, to the piece
     * `piece` in the room's space, as `set-slug` does, and returns the address
     * of the document that holds the binding.
     */
    pointSlug: async (
      slug: string,
      piece: string,
      at: MemorySpace = space,
    ): Promise<string> => {
      const runtime = ownerParty.runtime;
      const id = slugIdForSpace(at, slug);
      const slugCell = runtime.getCellFromEntityId(at, entityIdFrom(id));
      const target = runtime.getCellFromEntityId(space, entityIdFrom(piece));
      await runtime.editWithRetry((tx) => {
        const slugWithTx = slugCell.withTx(tx);
        slugWithTx.setRawUntyped(
          target.withTx(tx).getAsWriteRedirectLink({ base: slugWithTx }),
        );
      });
      await runtime.idle();
      await ownerParty.storage.synced();
      return id;
    },

    /**
     * A space that goes on existing, which grants `grants` beside the owner's
     * `OWNER`, and nobody else anything by default.
     */
    otherSpace: (grants: ACL = {}) =>
      ownerParty.runtime.createSpace({ grants }),

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

/** The code the error of a request that has to fail crosses with. */
async function codeOf(request: Promise<unknown>): Promise<unknown> {
  const failure = await request.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  return (failure as { code?: unknown }).code;
}

/** Lists the fields of a record in `space`, as `client` reads it. */
async function fieldsIn(
  client: RuntimeClient,
  space: MemorySpace,
): Promise<unknown> {
  const cell = await client.getCell(space, "space-root-open record");
  return await cell.fields();
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

  describe("a deleted space", () => {
    /**
     * Each load the shell can make of a view of `space`, none of which
     * resolves, or finds nothing, for a deleted space. `piece` names a piece
     * the space held.
     */
    const loads = (
      client: RuntimeClient,
      space: MemorySpace,
      piece: string,
    ) => [
      () => client.getSpaceRootPattern(space),
      () => client.getSpaceRootPattern(space, { start: false }),
      () => client.getPiece(piece, space),
      () => client.getPiece(piece, space, true),
      () => client.resolveSlug("top", space),
    ];

    for (const opener of ["owner", "visitor"] as const) {
      // The owner's runtime held the space when it was deleted, and its session
      // was revoked. The visitor's never opened it, and is refused on opening.
      it(`says so to a runtime that was the ${opener}, and fetches nothing`, async () => {
        await using room = await rootlessSpace({});
        const root = await room.owner.getSpaceRootPattern(room.space);
        await room.deleteSpace();
        const client = room[opener];
        room.fetched.length = 0;

        for (const load of loads(client, room.space, root!.id())) {
          expect(await codeOf(load())).toBe(RuntimeErrorCode.SpaceDeleted);
        }
        expect(room.fetched).toEqual([]);
      });
    }

    it("says so for a slug the runtime still holds", async () => {
      await using room = await rootlessSpace({});
      const root = await room.owner.getSpaceRootPattern(room.space);
      await room.pointSlug("held", root!.id());
      const before = await room.owner.resolveSlug("held", room.space);
      expect(before.refusal).toBeUndefined();

      await room.deleteSpace();

      expect(await codeOf(room.owner.resolveSlug("held", room.space)))
        .toBe(RuntimeErrorCode.SpaceDeleted);
    });

    it("says so for a redirect from a space that goes on existing", async () => {
      await using room = await rootlessSpace({});
      const root = await room.owner.getSpaceRootPattern(room.space);
      const live = await room.otherSpace();
      const redirect = await room.pointSlug("into", root!.id(), live);
      await room.deleteSpace();
      room.fetched.length = 0;

      expect(await codeOf(room.owner.getPiece(redirect, live, true)))
        .toBe(RuntimeErrorCode.SpaceDeleted);
      expect(room.fetched).toEqual([]);
    });

    it("has no event needing attention", async () => {
      await using room = await rootlessSpace({});
      await room.owner.getSpaceRootPattern(room.space);
      await room.deleteSpace();

      expect(await room.visitor.listEventAttention(room.space)).toEqual([]);
    });
  });

  describe("a space that refuses the runtime", () => {
    /**
     * Each read of `space` that `client` can ask the worker for, none of
     * which resolves for a space that refuses it. `piece` names a piece the
     * space holds.
     */
    const reads = (
      client: RuntimeClient,
      space: MemorySpace,
      piece: string,
    ) => [
      () => fieldsIn(client, space),
      () => client.getSpaceRootPattern(space),
      () => client.getSpaceRootPattern(space, { start: false }),
      () => client.getPiece(piece, space),
      () => client.getPiece(piece, space, true),
      () => client.resolveSlug("top", space),
    ];

    it("fails each read with `SpaceAccessRefused` for a principal it never admitted", async () => {
      await using room = await rootlessSpace({});
      const root = await room.owner.getSpaceRootPattern(room.space);

      for (const read of reads(room.visitor, room.space, root!.id())) {
        expect(await codeOf(read())).toBe(RuntimeErrorCode.SpaceAccessRefused);
      }
    });

    it("fails each read with `SpaceAccessRefused` for a principal it stopped admitting", async () => {
      await using room = await rootlessSpace({ [visitor.did()]: "READ" });
      const root = await room.owner.getSpaceRootPattern(room.space);
      await room.pointSlug("held", root!.id());
      expect(await fieldsIn(room.visitor, room.space)).toBeUndefined();
      expect(await room.visitor.getPiece(root!.id(), room.space)).toBeDefined();
      const before = await room.visitor.resolveSlug("held", room.space);
      expect(before.refusal).toBeUndefined();

      await room.revokeVisitor();

      for (const read of reads(room.visitor, room.space, root!.id())) {
        expect(await codeOf(read())).toBe(RuntimeErrorCode.SpaceAccessRefused);
      }
      expect(await codeOf(room.visitor.resolveSlug("held", room.space)))
        .toBe(RuntimeErrorCode.SpaceAccessRefused);
    });

    it("fails a redirect into it from a space that admits the principal with `SpaceAccessRefused`", async () => {
      await using room = await rootlessSpace({});
      const root = await room.owner.getSpaceRootPattern(room.space);
      const live = await room.otherSpace({ [visitor.did()]: "READ" });
      const redirect = await room.pointSlug("into", root!.id(), live);

      expect(await codeOf(room.visitor.getPiece(redirect, live, true)))
        .toBe(RuntimeErrorCode.SpaceAccessRefused);
    });

    it("fails a denied operation with no code while the space stays readable", async () => {
      // The memory server refuses a `WRITE` member's change to the access
      // list as an `AuthorizationError`, as it refuses a read, but the space
      // is still the member's to read.
      await using room = await rootlessSpace({ [visitor.did()]: "WRITE" });

      const denied = room.visitor.setSpaceAclEntry(
        room.space,
        visitor.did(),
        "OWNER",
      );

      await expect(denied).rejects.toThrow("lacks OWNER");
      expect(await codeOf(denied)).toBe(undefined);
      expect(await fieldsIn(room.visitor, room.space)).toBeUndefined();
    });

    it("fails a read with `SpaceDeleted` instead once the space is deleted", async () => {
      await using room = await rootlessSpace({});
      expect(await fieldsIn(room.owner, room.space)).toBeUndefined();

      await room.deleteSpace();

      for (const client of [room.owner, room.visitor]) {
        expect(await codeOf(fieldsIn(client, room.space)))
          .toBe(RuntimeErrorCode.SpaceDeleted);
      }
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
