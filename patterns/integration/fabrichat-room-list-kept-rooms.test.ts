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
 * makes once. `fabrichat-room-list-fixture.ts` holds the server and clients
 * the `fabrichat-room-list-*` files share.
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID, Identity } from "@commonfabric/identity";
import { isDeletedSpaceError } from "@commonfabric/memory/v2/client";
import type { Cell, MemorySpace } from "@commonfabric/runner";
import {
  CHAT_START,
  closeMember,
  openMember,
  sendTrusted,
} from "./fabrichat-room-fixture.ts";
import {
  arrivedIn,
  type Client,
  HANDLE,
  heldIn,
  memberOf,
  openedOf,
  RoomListServer,
  ROOMS,
  type Row,
} from "./fabrichat-room-list-fixture.ts";

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

  describe("a fresh client listing the rooms", () => {
    let client: Client;
    let rows: Row[];

    beforeAll(async () => {
      client = await fabric.bootClient({ person: owner });
      rows = await fabric.listRooms(client, ROOMS + 2);
    });

    afterAll(async () => {
      await client?.controller.dispose();
    });

    it("lists every room with the kind and title its manager recorded", () => {
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

    it("receives no document from any room's space, from bring-up on", () => {
      const spaces = [...kept, deleted, revoked];
      expect(arrivedIn(client, spaces)).toEqual(spaces.map(() => 0));
      expect(heldIn(client, spaces)).toEqual(spaces.map(() => 0));
    });

    it("is refused no room's space while it lists them", () => {
      expect([...client.refused.keys()]).toEqual([]);
    });

    it("opens no session to any room's space, from bring-up on", () => {
      expect(openedOf(client, [...kept, deleted, revoked])).toEqual([]);
    });

    it("receives no document from another room's space when it creates a group", async () => {
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
    let client: Client;

    beforeAll(async () => {
      client = await fabric.bootClient({ person: owner });
      await fabric.listRooms(client, ROOMS + 2);
    });

    afterAll(async () => {
      await client?.controller.dispose();
    });

    it("receives no document from any room's space either", () => {
      const spaces = [...kept, deleted, revoked];
      expect(arrivedIn(client, spaces)).toEqual(spaces.map(() => 0));
      expect(openedOf(client, spaces)).toEqual([]);
    });
  });

  //
  // A client that subscribes before Home is brought up
  //

  describe("a fresh client subscribing to the list before Home is brought up", () => {
    let client: Client;

    beforeAll(async () => {
      client = await fabric.bootClient({ early: true, person: owner });
      await fabric.listRooms(client, ROOMS + 2);
    });

    afterAll(async () => {
      await client?.controller.dispose();
    });

    it("receives no document from any room's space, from bring-up on", () => {
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
    let legacy: DID;
    let client: Client;
    let before: Row[];
    let after: Row[];

    beforeAll(async () => {
      // A room listed before the manager recorded memberships: its catalog
      // entry is there, and its membership is not.
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
      client = await fabric.bootClient({ adopt: false, person: owner });
      before = await fabric.listRooms(client, ROOMS + 2);
      await client.controller.adoptCatalogRooms();
      after = await fabric.listRooms(client, before.length + 1);
    });

    afterAll(async () => {
      await client?.controller.dispose();
    });

    it("lists the room once the host adopts it, and not before", () => {
      expect(before.map((row) => row.room.space)).not.toContain(legacy);
      expect(after.find((row) => row.room.space === legacy)?.title).toBe(
        "Legacy room",
      );
    });

    it("reads the adopted room's space, and no other room's", () => {
      expect(client.arrived.get(legacy)?.size ?? 0).toBeGreaterThan(0);
      expect(arrivedIn(client, kept)).toEqual(kept.map(() => 0));
    });
  });

  //
  // Opening a room that is gone
  //

  describe("opening a room that is gone", () => {
    let client: Client;

    beforeAll(async () => {
      client = await fabric.bootClient({ person: owner });
      const rows = await fabric.listRooms(client, ROOMS + 2);
      const storage = client.controller.runtime.storageManager;
      for (const space of [deleted, revoked]) {
        const row = rows.find((each) => each.room.space === space)!;
        await row.room.sync();
        await storage.awaitSpaceAnswer?.(space as MemorySpace);
      }
    });

    afterAll(async () => {
      await client?.controller.dispose();
    });

    it("is refused a deleted room's space as deleted", () => {
      const error = client.refused.get(deleted);
      expect(error?.name).toBe("AuthorizationError");
      expect(isDeletedSpaceError(error)).toBe(true);
    });

    it("is refused a revoked room's space, not as deleted", () => {
      const error = client.refused.get(revoked);
      expect(error?.name).toBe("AuthorizationError");
      expect(isDeletedSpaceError(error)).toBe(false);
    });

    it("receives no document from the rooms it didn't open", () => {
      expect(arrivedIn(client, kept)).toEqual(kept.map(() => 0));
    });

    it("has opened a session to the rooms it opened, and to no other room", () => {
      expect(openedOf(client, [...kept, deleted, revoked]).sort()).toEqual(
        [deleted, revoked].sort(),
      );
    });
  });
});
