/**
 * What adopting the rooms a person's catalog lists with no membership leaves
 * running on the client that adopts them: the room pieces adoption starts,
 * each stopped once the room is joined, unless the client opened the room
 * itself. Such a catalog is one kept before the manager recorded memberships.
 *
 * Each scenario has a fresh person keep rooms of their own, and is set up when
 * the first of its tests reads it.
 * `fabrichat-room-list-fixture.ts` holds the server and clients the
 * `fabrichat-room-list-*` files share.
 */

import { expect } from "@std/expect";
import type { Cell } from "@commonfabric/runner";
import {
  afterAll,
  beforeAll,
  describe,
  it,
} from "@commonfabric/test-support/test";
import {
  adoptedRooms,
  arrivedIn,
  HANDLE,
  RoomListServer,
  roomNodesOn,
  runningOn,
  serving,
} from "./fabrichat-room-list-fixture.ts";
import { once } from "./multi-runtime-harness.ts";

describe("fabrichat-room-list-adoption", () => {
  let fabric: RoomListServer;

  beforeAll(async () => {
    fabric = await RoomListServer.start();
  });

  afterAll(async () => {
    await fabric?.close();
  });

  describe("adopting rooms the catalog lists with no membership", () => {
    const adopting = once(async () => {
      const { person, rooms } = await fabric.personWithRooms("erin", 3);
      const noRoom = await fabric.orphanRooms(person, rooms);
      const client = await fabric.bootClient({ adopt: false, person });
      const runningBefore = runningOn(client);
      const roomNodesBefore = roomNodesOn(client);
      const stopped = await client.controller.adoptCatalogRooms();
      await fabric.settle(client.controller);
      const outcomes = await adoptedRooms(client, [...rooms, noRoom]);
      return {
        person,
        rooms,
        client,
        runningBefore,
        roomNodesBefore,
        stopped,
        outcomes,
      };
    });

    afterAll(() => fabric.disposeClients());

    it("stops the piece of each room it joins", async () => {
      // Under server execution a client starts a room's piece only where its
      // own echo of the join reaches the room, which it does for some of the
      // rooms and not others from run to run; each piece it does start is
      // stopped, and none is left running, as the next case says.
      if (serving) return;
      const { rooms, stopped } = await adopting();
      expect(stopped).toBe(rooms.length);
    });

    it("leaves no room's piece running, and no node of the room pattern", async () => {
      const { rooms, client, roomNodesBefore, outcomes } = await adopting();
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
      const { rooms, client } = await adopting();
      const overlay = client.controller.runtime.speculationOverlay;
      expect(overlay).toBeDefined();
      await overlay!.waitForIntentQuiescence();
      expect(overlay!.pendingIntentCount).toBe(0);
      expect(rooms.map((space) => overlay!.entryCount(space))).toEqual(
        rooms.map(() => 0),
      );
    });

    it("leaves the pieces that ran before it running, and no other", async () => {
      const { client, runningBefore } = await adopting();
      expect(runningOn(client)).toEqual(runningBefore);
    });

    it("records each room's adoption, and refuses the space with no room", async () => {
      const { rooms, outcomes } = await adopting();
      expect(outcomes.map(({ status }) => status)).toEqual([
        ...rooms.map(() => "done"),
        "refused",
      ]);
    });

    describe("a client booting after the adoption", () => {
      const booting = once(async () => {
        const { person, rooms } = await adopting();
        const second = await fabric.bootClient({ adopt: false, person });
        const secondStopped = await second.controller.adoptCatalogRooms();
        await fabric.settle(second.controller);
        // The documents each room's space delivered to it while it adopted.
        const arrivedWhileAdopting = arrivedIn(second, rooms);
        return { rooms, secondStopped, arrivedWhileAdopting };
      });

      it("adopts nothing, and receives no document from any room's space", async () => {
        const { rooms, secondStopped, arrivedWhileAdopting } = await booting();
        expect(secondStopped).toBe(0);
        expect(arrivedWhileAdopting).toEqual(rooms.map(() => 0));
      });
    });
  });

  describe("adopting a room that a client opens while it adopts", () => {
    const adopting = once(async () => {
      const { person, rooms } = await fabric.personWithRooms("frank", 2);
      await fabric.orphanRooms(person, rooms);
      const client = await fabric.bootClient({ adopt: false, person });
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
      let stopped: number;
      try {
        stopped = await client.controller.adoptCatalogRooms();
        await opened.promise;
      } finally {
        cancel();
      }
      await fabric.settle(client.controller);
      const outcomes = await adoptedRooms(client, rooms);
      return { client, stopped, outcomes };
    });

    afterAll(() => fabric.disposeClients());

    it("leaves the opened room's piece running, and stops the other's", async () => {
      const { client, stopped, outcomes } = await adopting();
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
