/**
 * What adopting the rooms a person's catalog lists with no membership leaves
 * running on the client that adopts them: the room pieces adoption starts,
 * each stopped once the room is joined, unless the client opened the room
 * itself. Such a catalog is one kept before the manager recorded memberships.
 *
 * Each scenario has a fresh person keep rooms of their own.
 * `fabrichat-room-list-fixture.ts` holds the server and clients the
 * `fabrichat-room-list-*` files share.
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID, Identity } from "@commonfabric/identity";
import type { Cell } from "@commonfabric/runner";
import {
  adoptedRooms,
  arrivedIn,
  type Client,
  HANDLE,
  RoomListServer,
  roomNodesOn,
  runningOn,
  serving,
} from "./fabrichat-room-list-fixture.ts";

describe("fabrichat-room-list-adoption", () => {
  let fabric: RoomListServer;

  beforeAll(async () => {
    fabric = await RoomListServer.start();
  });

  afterAll(async () => {
    await fabric?.close();
  });

  describe("adopting rooms the catalog lists with no membership", () => {
    let person: Identity;
    let rooms: DID[];
    let noRoom: DID;
    let client: Client;
    let runningBefore: string[];
    let roomNodesBefore: number;
    let stopped: number;
    let outcomes: { status?: string; room?: Cell<unknown> }[];

    beforeAll(async () => {
      const made = await fabric.personWithRooms("erin", 3);
      person = made.person;
      rooms = made.rooms;
      noRoom = await fabric.orphanRooms(person, rooms);
      client = await fabric.bootClient({ adopt: false, person });
      runningBefore = runningOn(client);
      roomNodesBefore = roomNodesOn(client);
      stopped = await client.controller.adoptCatalogRooms();
      await fabric.settle(client.controller);
      outcomes = await adoptedRooms(client, [...rooms, noRoom]);
    });

    afterAll(async () => {
      await client?.controller.dispose();
    });

    it("stops the piece of each room it joins", () => {
      // Under server execution a client starts a room's piece only where its
      // own echo of the join reaches the room, which it does for some of the
      // rooms and not others from run to run; each piece it does start is
      // stopped, and none is left running, as the next case says.
      if (serving) return;
      expect(stopped).toBe(rooms.length);
    });

    it("leaves no room's piece running, and no node of the room pattern", () => {
      expect(
        outcomes.slice(0, rooms.length).map(({ room }) =>
          room !== undefined &&
          client.controller.runtime.runner.isRunning(room)
        ),
      ).toEqual(rooms.map(() => false));
      expect(roomNodesBefore).toBe(0);
      expect(roomNodesOn(client)).toBe(0);
    });

    it("leaves no intent outstanding and no speculative entry in a room's space", async () => {
      // Only a client under server execution echoes the joins.
      if (!serving) return;
      const overlay = client.controller.runtime.speculationOverlay;
      expect(overlay).toBeDefined();
      await overlay!.waitForIntentQuiescence();
      expect(overlay!.pendingIntentCount).toBe(0);
      expect(rooms.map((space) => overlay!.entryCount(space))).toEqual(
        rooms.map(() => 0),
      );
    });

    it("leaves the pieces that ran before it running, and no other", () => {
      expect(runningOn(client)).toEqual(runningBefore);
    });

    it("records each room's adoption, and refuses the space with no room", () => {
      expect(outcomes.map(({ status }) => status)).toEqual([
        ...rooms.map(() => "done"),
        "refused",
      ]);
    });

    describe("a client booting after the adoption", () => {
      let second: Client;
      let secondStopped: number;

      /** The documents each room's space delivered to it while it adopted. */
      let arrivedWhileAdopting: number[];

      beforeAll(async () => {
        second = await fabric.bootClient({ adopt: false, person });
        secondStopped = await second.controller.adoptCatalogRooms();
        await fabric.settle(second.controller);
        arrivedWhileAdopting = arrivedIn(second, rooms);
      });

      afterAll(async () => {
        await second?.controller.dispose();
      });

      it("adopts nothing, and receives no document from any room's space", () => {
        expect(secondStopped).toBe(0);
        expect(arrivedWhileAdopting).toEqual(rooms.map(() => 0));
      });
    });
  });

  describe("adopting a room that a client opens while it adopts", () => {
    let rooms: DID[];
    let client: Client;
    let stopped: number;
    let outcomes: { status?: string; room?: Cell<unknown> }[];

    beforeAll(async () => {
      const made = await fabric.personWithRooms("frank", 2);
      rooms = made.rooms;
      await fabric.orphanRooms(made.person, rooms);
      client = await fabric.bootClient({ adopt: false, person: made.person });
      // The client opens the first room as a page does, as soon as the
      // adoption has recorded its membership.
      const opened = Promise.withResolvers<void>();
      const memberships = client.home.key("chatManager").key("roomMembership")
        .asSchema<{ room?: Cell<unknown> }[]>({
          type: "array",
          items: { type: "object", properties: { room: HANDLE } },
        });
      let opening: Promise<void> | undefined;
      const cancel = memberships.sink((list) => {
        const room = list?.find((each) => each?.room?.space === rooms[0])
          ?.room;
        if (room === undefined || opening !== undefined) return;
        opening = client.controller.startPiece(room).then(opened.resolve);
      });
      try {
        stopped = await client.controller.adoptCatalogRooms();
        await opened.promise;
      } finally {
        cancel();
      }
      await fabric.settle(client.controller);
      outcomes = await adoptedRooms(client, rooms);
    });

    afterAll(async () => {
      await client?.controller.dispose();
    });

    it("leaves the opened room's piece running, and stops the other's", () => {
      expect(
        outcomes.map(({ room }) =>
          room !== undefined &&
          client.controller.runtime.runner.isRunning(room)
        ),
      ).toEqual([true, false]);
      // As above: under server execution the count varies from run to run.
      if (!serving) expect(stopped).toBe(1);
    });
  });
});
