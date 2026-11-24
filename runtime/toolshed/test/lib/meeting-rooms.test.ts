import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Database } from "@db/sqlite";

import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import type { DID } from "@commonfabric/memory/interface";
import { encodeMemoryBoundary } from "@commonfabric/memory/v2";
import { Server } from "@commonfabric/memory/v2/server";
import { verifySessionOpenAuthorization } from "@commonfabric/memory/v2/session-open-auth";
import { LoopbackStorageManager } from "@commonfabric/runner/executor/loopback-storage";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";

import {
  loomSpaceCreator,
  MeetingRoomError,
  type MeetingRoomRequest,
  MeetingRooms,
} from "@/lib/meeting-rooms.ts";
import { createMeetingRoomRouter } from "@/routes/meeting-rooms/router.ts";

const HOST = "https://meeting-host.example";

/** A synthetic occurrence with a distinct publication intent per caller. */
function proposal(): MeetingRoomRequest {
  return {
    key: {
      scheme: "ical-uid-slot",
      item_key: "a".repeat(64),
      occurrence_key: "b".repeat(64),
    },
    requestId: crypto.randomUUID(),
    candidate: {
      root: { cause: JSON.stringify({ publication: crypto.randomUUID() }) },
    },
  };
}

describe("meeting-rooms", () => {
  let directory: string;
  let path: string;
  let server: Server;
  let alice: Identity;
  let bob: Identity;
  let candidates: string[];

  /** A host that verifies production session proofs and enforces space ACLs. */
  function memoryServer(): Server {
    return new Server({
      store: toFileUrl(directory + "/spaces/"),
      acl: { mode: "enforce" },
      authorizeSessionOpen: verifySessionOpenAuthorization,
      sessionOpenAuth: { audience: alice.did() },
      subscriptionRefreshDelayMs: 0,
    });
  }

  /** An independent service object sharing only the host's durable store. */
  function rooms(): MeetingRooms {
    const create = loomSpaceCreator(
      (options: { as: Identity }) =>
        LoopbackStorageManager.connect(server, options),
      { as: alice },
    );
    return new MeetingRooms({
      path,
      server,
      createSpace: async (creator, root) => {
        const space = await create(creator, root);
        candidates.push(space);
        return space;
      },
    });
  }

  /** The canonical allocation metadata. */
  function allocations() {
    const db = new Database(path, { readonly: true });
    try {
      return db.prepare(
        "SELECT space, creator FROM meeting_rooms",
      ).all();
    } finally {
      db.close();
    }
  }

  beforeEach(async () => {
    directory = await Deno.makeTempDir();
    path = directory + "/allocations.sqlite";
    alice = await Identity.generate({ implementation: "noble" });
    bob = await Identity.generate({ implementation: "noble" });
    server = memoryServer();
    candidates = [];
  });

  afterEach(async () => {
    await server.close();
    await Deno.remove(directory, { recursive: true });
  });

  describe("ensure()", () => {
    it("returns one address to independent concurrent creators with empty local lists", async () => {
      const first = proposal();
      const second = proposal();
      const [a, b] = await Promise.all([
        rooms().ensure(alice.did(), first),
        rooms().ensure(bob.did(), second),
      ]);
      expect(a.space).toBe(b.space);
      expect(a.creator).toBe(b.creator);
      expect(allocations()).toEqual([
        { space: a.space, creator: a.creator },
      ]);
      expect((await server.readDocument(a.space, aclDocId(a.space)))?.value)
        .toEqual({ [a.creator]: "OWNER" });
      expect(a.intent === undefined).toBe(a.creator !== alice.did());
      expect(b.intent === undefined).toBe(b.creator !== bob.did());
    });

    it("returns the retained intent after response loss and a full host restart", async () => {
      const request = proposal();
      const original = await rooms().ensure(alice.did(), request);
      await server.close();
      server = memoryServer();
      const retried = await rooms().ensure(alice.did(), request);
      expect(retried).toEqual(original);
      const late = await rooms().ensure(bob.did(), proposal());
      expect(late).toEqual({ space: original.space, creator: alice.did() });
      expect(allocations()).toHaveLength(1);
    });

    it("abandons an unpublished candidate after a failure before association and creates one canonical room on retry", async () => {
      const interrupted = stub(server, "flushSpace", () => {
        throw new Error("process stopped before association");
      });
      try {
        await expect(rooms().ensure(alice.did(), proposal()))
          .rejects.toThrow("process stopped before association");
      } finally {
        interrupted.restore();
      }
      expect(candidates).toHaveLength(1);
      const abandoned = candidates[0];
      expect(allocations()).toHaveLength(0);
      await server.close();
      server = memoryServer();
      const recovered = await rooms().ensure(bob.did(), proposal());
      expect(recovered.space).not.toBe(abandoned);
      expect(candidates).toHaveLength(2);
      expect(await rooms().ensure(alice.did(), proposal())).toEqual({
        space: recovered.space,
        creator: bob.did(),
      });
      expect(allocations()).toEqual([
        { space: recovered.space, creator: bob.did() },
      ]);
    });

    it("records no canonical address until the space's durability barrier succeeds", async () => {
      const interrupted = stub(server, "flushSpace", () => {
        expect(allocations()).toHaveLength(0);
        throw new Error("space could not be flushed");
      });
      try {
        await expect(rooms().ensure(alice.did(), proposal()))
          .rejects.toThrow("space could not be flushed");
      } finally {
        interrupted.restore();
      }
      expect(allocations()).toHaveLength(0);
      const resumed = await rooms().ensure(alice.did(), proposal());
      expect(allocations()).toEqual([
        { space: resumed.space, creator: alice.did() },
      ]);
    });

    it("returns an inaccessible winner without granting access or allocating a replacement", async () => {
      const original = await rooms().ensure(alice.did(), proposal());
      const late = await rooms().ensure(bob.did(), proposal());
      expect(late).toEqual({ space: original.space, creator: alice.did() });
      expect(
        (await server.readDocument(late.space, aclDocId(late.space)))?.value,
      )
        .toEqual({ [alice.did()]: "OWNER" });
      expect(allocations()).toHaveLength(1);
    });

    it("allocates separate rooms for different occurrence or item signatures", async () => {
      const a = proposal();
      const b = proposal();
      b.key.occurrence_key = "c".repeat(64);
      const c = proposal();
      c.key.item_key = "d".repeat(64);
      const addresses = await Promise.all([a, b, c].map(
        (request) => rooms().ensure(alice.did(), request),
      ));
      expect(new Set(addresses.map((room) => room.space)).size).toBe(3);
      expect(allocations()).toHaveLength(3);
    });

    it("throws when a retained allocating request changes its occurrence", async () => {
      const request = proposal();
      await rooms().ensure(alice.did(), request);
      request.key.occurrence_key = "c".repeat(64);
      await expect(rooms().ensure(alice.did(), request))
        .rejects.toThrow(MeetingRoomError);
      expect(allocations()).toHaveLength(1);
      expect(candidates).toHaveLength(1);
    });

    it("rejects a request that changes occurrence even when the target already has a room", async () => {
      const first = proposal();
      await rooms().ensure(alice.did(), first);
      const second = proposal();
      second.key.occurrence_key = "c".repeat(64);
      await rooms().ensure(bob.did(), second);
      const changed = { ...first, key: second.key };
      await expect(rooms().ensure(alice.did(), changed))
        .rejects.toThrow(MeetingRoomError);
      expect(candidates).toHaveLength(2);
      expect(allocations()).toHaveLength(2);
    });

    it("gives every association-store connection a bounded native lock wait", async () => {
      const execute = Database.prototype.exec;
      const waits: number[] = [];
      const configured = stub(
        Database.prototype,
        "exec",
        function (this: Database, ...args: Parameters<Database["exec"]>) {
          const result = execute.apply(this, args);
          if (this.path === path) {
            waits.push(
              Number(this.prepare("PRAGMA busy_timeout").get()?.timeout),
            );
          }
          return result;
        },
      );
      try {
        await rooms().ensure(alice.did(), proposal());
      } finally {
        configured.restore();
      }
      expect(waits.length).toBeGreaterThan(0);
      for (const wait of waits) {
        expect(wait).toBeGreaterThan(0);
        expect(wait).toBeLessThanOrEqual(5000);
      }
    });

    it("retains an existing legacy room only for its explicit owner", async () => {
      const storage = LoopbackStorageManager.connect(server, { as: alice });
      let space: DID;
      try {
        space = await storage.createSpace({ [alice.did()]: "OWNER" });
      } finally {
        await storage.close();
      }
      const request = { ...proposal(), candidate: { space } };
      await expect(rooms().ensure(bob.did(), request))
        .rejects.toThrow(MeetingRoomError);
      expect(allocations()).toHaveLength(0);
      const adopted = await rooms().ensure(alice.did(), request);
      expect(adopted).toEqual({ space, creator: alice.did() });
      expect(await rooms().ensure(bob.did(), proposal()))
        .toEqual(adopted);
      expect(allocations()).toHaveLength(1);
    });

    it("propagates unreadable allocation storage without creating a space", async () => {
      await Deno.writeTextFile(path, "not a SQLite database");
      const read = stub(server, "readDocument");
      try {
        await expect(rooms().ensure(alice.did(), proposal())).rejects.toThrow();
        expect(read.calls).toHaveLength(0);
      } finally {
        read.restore();
      }
    });

    it("throws for a principal that is not a space DID, and records nothing", async () => {
      await expect(rooms().ensure("not-a-did", proposal())).rejects.toThrow(
        "Invalid principal",
      );
      expect(candidates).toEqual([]);
      expect(Array.from(Deno.readDirSync(directory))).toHaveLength(0);
    });

    it("throws when the created space is not a space DID, and records nothing", async () => {
      const bogus = new MeetingRooms({
        path,
        server,
        createSpace: () => Promise.resolve("did:key:bogus"),
      });

      await expect(bogus.ensure(alice.did(), proposal())).rejects.toThrow(
        "Invalid created space DID",
      );
      expect(allocations()).toEqual([]);
    });

    it("throws for the allocating principal when its retained root no longer decodes as one", async () => {
      const request = proposal();
      const original = await rooms().ensure(alice.did(), request);
      const db = new Database(path);
      try {
        db.prepare("UPDATE meeting_rooms SET root = ?").run(
          encodeMemoryBoundary({ cause: "" }),
        );
      } finally {
        db.close();
      }

      await expect(rooms().ensure(alice.did(), request)).rejects.toThrow(
        "Invalid retained genesis root",
      );
      // Another caller is never handed the intent, so it never decodes it.
      expect(await rooms().ensure(bob.did(), proposal())).toEqual({
        space: original.space,
        creator: alice.did(),
      });
    });
  });

  describe("loomSpaceCreator()", () => {
    it("closes the storage it opened when creating the space fails", async () => {
      const opened: string[] = [];
      const closed: string[] = [];
      const create = loomSpaceCreator((name: string) => {
        opened.push(name);
        return {
          createSpace: () => Promise.reject(new Error("genesis refused")),
          close: () => {
            closed.push(name);
            return Promise.resolve();
          },
        };
      }, "storage-options");

      await expect(create(alice.did(), { cause: "room" })).rejects.toThrow(
        "genesis refused",
      );
      expect(opened).toEqual(["storage-options"]);
      expect(closed).toEqual(["storage-options"]);
    });
  });

  describe("HTTP boundary", () => {
    /** A proof bound to the configured public authority and exact request body. */
    function signed(body: unknown, signer = alice): Promise<Request> {
      return signedBytes(
        new TextEncoder().encode(JSON.stringify(body)),
        signer,
      );
    }

    /** A proof bound to the configured public authority and these bytes. */
    async function signedBytes(
      bytes: Uint8Array<ArrayBuffer>,
      signer = alice,
    ): Promise<Request> {
      const url = HOST + "/api/meeting-rooms/ensure";
      const headers = await signFirstPartyHttpRequest({
        signer,
        method: "POST",
        url: new URL(url),
        body: bytes,
      });
      headers.set("Content-Type", "application/json");
      return new Request(url, { method: "POST", body: bytes, headers });
    }

    it("returns the same canonical address after a committed HTTP response is discarded", async () => {
      const app = createMeetingRoomRouter({ rooms: rooms(), host: HOST });
      const request = proposal();
      const lost = await app.fetch(await signed(request));
      expect(lost.status).toBe(200);
      const retained = allocations()[0];
      const retry = await app.fetch(await signed(request));
      expect(await retry.json()).toMatchObject({ space: retained?.space });
      const late = await app.fetch(await signed(proposal(), bob));
      expect(await late.json()).toEqual({
        space: retained?.space,
        creator: alice.did(),
      });
      expect(allocations()).toHaveLength(1);
    });

    it("refuses unsigned, altered, and foreign-authority requests", async () => {
      const app = createMeetingRoomRouter({ rooms: rooms(), host: HOST });
      const request = await signed(proposal());
      const altered = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(proposal()),
      });
      const foreign = createMeetingRoomRouter({
        rooms: rooms(),
        host: "https://another-host.example",
      });
      const responses = await Promise.all([
        app.fetch(new Request(request.url, { method: "POST", body: "{}" })),
        app.fetch(altered),
        foreign.fetch(request),
      ]);
      expect(responses.map((response) => response.status)).toEqual([
        401,
        401,
        401,
      ]);
      expect(Array.from(Deno.readDirSync(directory))).toHaveLength(0);
    });

    it("refuses unrecognized fields and malformed occurrence claims", async () => {
      const app = createMeetingRoomRouter({ rooms: rooms(), host: HOST });
      const invalid = [
        { ...proposal(), principal: bob.did() },
        {
          ...proposal(),
          key: { ...proposal().key, occurrence_key: "local-id" },
        },
        { ...proposal(), candidate: { root: { cause: "" } } },
      ];
      const responses = await Promise.all(
        invalid.map(async (body) => app.fetch(await signed(body))),
      );
      expect(responses.map((response) => response.status)).toEqual([
        400,
        400,
        400,
      ]);
      expect(Array.from(Deno.readDirSync(directory))).toHaveLength(0);
    });

    it("advertises host scope and refuses mutations when a shared authority is unavailable", async () => {
      const app = createMeetingRoomRouter({
        rooms: rooms(),
        host: HOST,
        available: false,
      });
      expect(await (await app.request(HOST + "/api/meeting-rooms")).json())
        .toEqual({ scope: "host", available: false });
      expect((await app.fetch(await signed(proposal()))).status).toBe(503);
      expect(Array.from(Deno.readDirSync(directory))).toHaveLength(0);
    });

    it("returns 400 for a signed body that is not JSON", async () => {
      const app = createMeetingRoomRouter({ rooms: rooms(), host: HOST });

      const response = await app.fetch(
        await signedBytes(new TextEncoder().encode("{not json")),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "invalid-request" });
      expect(Array.from(Deno.readDirSync(directory))).toHaveLength(0);
    });

    it("returns 413 for a body over the size limit before checking its proof", async () => {
      const app = createMeetingRoomRouter({ rooms: rooms(), host: HOST });

      const response = await app.fetch(
        new Request(HOST + "/api/meeting-rooms/ensure", {
          method: "POST",
          body: "x".repeat(16385),
        }),
      );

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ code: "invalid-request" });
    });

    it("returns 403 to a caller that does not own its candidate space", async () => {
      const storage = LoopbackStorageManager.connect(server, { as: alice });
      let space: DID;
      try {
        space = await storage.createSpace({ [alice.did()]: "OWNER" });
      } finally {
        await storage.close();
      }
      const app = createMeetingRoomRouter({ rooms: rooms(), host: HOST });

      const response = await app.fetch(
        await signed({ ...proposal(), candidate: { space } }, bob),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "not-owner" });
      expect(allocations()).toEqual([]);
    });

    it("returns 409 for a request id retained for another occurrence", async () => {
      const app = createMeetingRoomRouter({ rooms: rooms(), host: HOST });
      const request = proposal();
      expect((await app.fetch(await signed(request))).status).toBe(200);

      const response = await app.fetch(
        await signed({
          ...request,
          key: { ...request.key, occurrence_key: "c".repeat(64) },
        }),
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: "request-conflict" });
      expect(allocations()).toHaveLength(1);
    });

    it("returns 500 with a fixed code for any other failure, and records nothing", async () => {
      using _flush = stub(server, "flushSpace", () => {
        throw new Error("disk on fire");
      });
      const app = createMeetingRoomRouter({ rooms: rooms(), host: HOST });

      const response = await app.fetch(await signed(proposal()));

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ code: "service-error" });
      expect(allocations()).toEqual([]);
    });
  });
});
