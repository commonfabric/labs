/**
 * What a fresh client of a person's Home loads in the spaces of the person's
 * FabriChat rooms while it brings Home up and lists the rooms, the way a
 * client that draws natively does: nothing, at any point, however many rooms
 * there are. The manager lists a room from its own records, and every link to
 * a room those records hold is a handle that declares nothing of the room, so
 * neither Home's sync nor a read of the list reaches a room's space. A room is
 * checked when it is opened, which is where a deleted room, or one that no
 * longer admits the person, is refused.
 *
 * Every scenario here lists the same person's rooms, which the file's setup
 * makes once, and each scenario's own setup runs when the first of its tests
 * reads it. `fabrichat-room-list-fixture.ts` holds the server and clients
 * the `fabrichat-room-list-*` files share.
 */

import { expect } from "@std/expect";
import type { DID, Identity } from "@commonfabric/identity";
import { isDeletedSpaceError } from "@commonfabric/memory/v2/client";
import type { Cell, MemorySpace } from "@commonfabric/runner";
import {
  afterAll,
  beforeAll,
  describe,
  it,
} from "@commonfabric/test-support/test";
import {
  CHAT_START,
  closeMember,
  openMember,
  sendTrusted,
} from "./fabrichat-room-fixture.ts";
import {
  arrivedIn,
  HANDLE,
  heldIn,
  memberOf,
  openedOf,
  RoomListServer,
  ROOMS,
  SENT,
} from "./fabrichat-room-list-fixture.ts";
import { once } from "./multi-runtime-harness.ts";

describe("fabrichat-room-list-kept-rooms", () => {
  let fabric: RoomListServer;
  let owner: Identity;
  let bob: Identity;

  /** The spaces of the rooms the person keeps, in the order they were made. */
  let kept: DID[];

  /** A room deleted after it was listed. */
  let deleted: DID;

  /** A room whose space no longer admits the person. */
  let revoked: DID;

  beforeAll(async () => {
    fabric = await RoomListServer.start();
    ({ owner, bob, kept, deleted, revoked } = await fabric.keptRooms());
  });

  afterAll(async () => {
    await fabric?.close();
  });

  //
  // Listing the rooms
  //

  /** A fresh client of the person's Home, once it has listed their rooms. */
  const listing = once(async () => {
    const client = await fabric.bootClient({ person: owner });
    const rows = await fabric.listRooms(client, ROOMS + 2);
    return { client, rows };
  });

  describe("a fresh client listing the rooms", () => {
    afterAll(() => fabric.disposeClients());

    it("lists every room with the kind and title its manager recorded", async () => {
      const { rows } = await listing();
      const titles = rows.map((row) => row.title)
        .filter((title) => title !== "Later room").sort();
      expect(titles).toEqual([
        "Deleted room",
        "Revoked room",
        ...kept.map((_, index) => `Room ${index}`),
      ].sort());
      expect(rows.every((row) => row.kind === "group")).toBe(true);
      expect(
        rows.filter((row) => row.title !== "Later room")
          .map((row) => row.room.space).sort(),
      ).toEqual([...kept, deleted, revoked].sort());
    });

    it("lists each room with the message count its manager last heard", async () => {
      const { rows } = await listing();
      const counts = kept.map((space) =>
        rows.find((row) => row.room.space === space)?.activity?.count
      );
      expect(counts).toEqual(kept.map((_, index) => SENT[index]));
      expect(
        rows.filter((row) => row.activity !== undefined)
          .every((row) => row.activity?.newestAt !== undefined),
      ).toBe(true);
    });

    it("receives no document from any room's space, from bring-up on", async () => {
      const { client } = await listing();
      const spaces = [...kept, deleted, revoked];
      expect(arrivedIn(client, spaces)).toEqual(spaces.map(() => 0));
      expect(heldIn(client, spaces)).toEqual(spaces.map(() => 0));
    });

    it("is refused no room's space while it lists them", async () => {
      const { client } = await listing();
      expect([...client.refused.keys()]).toEqual([]);
    });

    it("opens no session to any room's space, from bring-up on", async () => {
      const { client } = await listing();
      expect(openedOf(client, [...kept, deleted, revoked])).toEqual([]);
    });

    it("receives no document from another room's space when it creates a group", async () => {
      const { client } = await listing();
      const created = await fabric.createGroup(
        memberOf(client, owner),
        "later",
        "Later room",
      );
      const others = [...kept, deleted, revoked];
      expect(others).not.toContain(created);
      expect(arrivedIn(client, others)).toEqual(others.map(() => 0));
    });

    it("receives no document from another room's space when it opens a direct room", async () => {
      const { client } = await listing();
      const manager = client.home.key("chatManager");
      await sendTrusted(client.controller, manager.key("openDirect"), {
        requestId: "direct",
        counterpart: bob.did(),
      }, CHAT_START);
      const outcome = await client.waits.until(
        "the direct room with Bob",
        manager.key("requests").key("direct") as Cell<
          { status?: string } | undefined
        >,
        (value) => value?.status !== undefined,
      );
      await fabric.settle(client.controller);
      const others = [...kept, deleted, revoked];
      expect(outcome.status).toBe("done");
      expect(arrivedIn(client, others)).toEqual(others.map(() => 0));
    });
  });

  //
  // A replacement client
  //

  describe("a second fresh client of the same Home", () => {
    const replacing = once(async () => {
      await fabric.dispose((await listing()).client.controller);
      const client = await fabric.bootClient({ person: owner });
      await fabric.listRooms(client, ROOMS + 2);
      return client;
    });

    afterAll(() => fabric.disposeClients());

    it("receives no document from any room's space either", async () => {
      const client = await replacing();
      const spaces = [...kept, deleted, revoked];
      expect(arrivedIn(client, spaces)).toEqual(spaces.map(() => 0));
      expect(openedOf(client, spaces)).toEqual([]);
    });
  });

  //
  // A client that subscribes before Home is brought up
  //

  describe("a fresh client subscribing to the list before Home is brought up", () => {
    const subscribing = once(async () => {
      const client = await fabric.bootClient({ early: true, person: owner });
      await fabric.listRooms(client, ROOMS + 2);
      return client;
    });

    afterAll(() => fabric.disposeClients());

    it("receives no document from any room's space, from bring-up on", async () => {
      const client = await subscribing();
      const spaces = [...kept, deleted, revoked];
      expect(arrivedIn(client, spaces)).toEqual(spaces.map(() => 0));
      expect(heldIn(client, spaces)).toEqual(spaces.map(() => 0));
      expect(openedOf(client, spaces)).toEqual([]);
    });
  });

  //
  // Adopting a room the catalog lists with no membership
  //

  describe("a room the catalog lists with no membership", () => {
    const adopting = once(async () => {
      // A room listed before the manager recorded memberships: its catalog
      // entry is there, and its membership is not.
      let legacy: DID;
      const ada = await openMember(fabric.url, owner, 0);
      try {
        legacy = await fabric.createGroup(ada, "legacy", "Legacy room");
        const memberships = ada.home.key("chatManager").key("roomMembership");
        const rooms = memberships.asSchema<{ room?: Cell<unknown> }[]>({
          type: "array",
          items: { type: "object", properties: { room: HANDLE } },
        });
        const held = await rooms.pull() ?? [];
        const stored = memberships.resolveAsCell();
        const raw = stored.getRaw() as unknown[];
        const others = raw.filter((_, index) =>
          held[index]?.room?.space !== legacy
        );
        expect(others.length).toBe(raw.length - 1);
        const tx = ada.controller.runtime.edit();
        stored.withTx(tx).setRaw(others as never);
        const { error } = await tx.commit().settled;
        if (error) throw new Error(`Dropping the membership: ${error.message}`);
      } finally {
        await closeMember(ada);
      }
      const client = await fabric.bootClient({ adopt: false, person: owner });
      const before = await fabric.listRooms(client, ROOMS + 2);
      await client.controller.adoptCatalogRooms();
      const after = await fabric.listRooms(client, before.length + 1);
      return { legacy, client, before, after };
    });

    afterAll(() => fabric.disposeClients());

    it("lists the room once the host adopts it, and not before", async () => {
      const { legacy, before, after } = await adopting();
      expect(before.map((row) => row.room.space)).not.toContain(legacy);
      expect(after.find((row) => row.room.space === legacy)?.title).toBe(
        "Legacy room",
      );
    });

    it("reads the adopted room's space, and no other room's", async () => {
      const { legacy, client } = await adopting();
      expect(client.arrived.get(legacy)?.size ?? 0).toBeGreaterThan(0);
      expect(arrivedIn(client, kept)).toEqual(kept.map(() => 0));
    });
  });

  //
  // Opening a room that is gone
  //

  describe("opening a room that is gone", () => {
    const opening = once(async () => {
      const client = await fabric.bootClient({ person: owner });
      const rows = await fabric.listRooms(client, ROOMS + 2);
      const storage = client.controller.runtime.storageManager;
      for (const space of [deleted, revoked]) {
        const row = rows.find((each) => each.room.space === space)!;
        await row.room.sync();
        await storage.awaitSpaceAnswer?.(space as MemorySpace);
      }
      return client;
    });

    afterAll(() => fabric.disposeClients());

    it("is refused a deleted room's space as deleted", async () => {
      const client = await opening();
      const error = client.refused.get(deleted);
      expect(error?.name).toBe("AuthorizationError");
      expect(isDeletedSpaceError(error)).toBe(true);
    });

    it("is refused a revoked room's space, not as deleted", async () => {
      const client = await opening();
      const error = client.refused.get(revoked);
      expect(error?.name).toBe("AuthorizationError");
      expect(isDeletedSpaceError(error)).toBe(false);
    });

    it("receives no document from the rooms it didn't open", async () => {
      const client = await opening();
      expect(arrivedIn(client, kept)).toEqual(kept.map(() => 0));
    });

    it("has opened a session to the rooms it opened, and to no other room", async () => {
      const client = await opening();
      expect(openedOf(client, [...kept, deleted, revoked]).sort()).toEqual(
        [deleted, revoked].sort(),
      );
    });
  });
});
