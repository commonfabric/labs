/**
 * What adopting a room someone offered a person does to the room's roster,
 * when the person's Home registered the offer and its acceptance did not
 * land: the catalog lists the room with no membership, and adopting it puts
 * the person on the roster, once, however many people adopt it at once.
 *
 * Each scenario has fresh people of its own, and is set up when the first of
 * its tests reads it. `fabrichat-room-list-fixture.ts` holds the server and
 * clients the `fabrichat-room-list-*` files share.
 */

import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import { Identity } from "@commonfabric/identity";
import type { Cell } from "@commonfabric/runner";
import {
  afterAll,
  beforeAll,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { closeMember, openMember } from "./fabrichat-room-fixture.ts";
import {
  adoptedRooms,
  arrivedIn,
  HANDLE,
  identityNamed,
  RoomListServer,
  rosterOf,
  serving,
} from "./fabrichat-room-list-fixture.ts";
import { once } from "./multi-runtime-harness.ts";

describe("fabrichat-room-list-offered", () => {
  let fabric: RoomListServer;

  beforeAll(async () => {
    fabric = await RoomListServer.start();
  });

  afterAll(async () => {
    await fabric?.close();
  });

  describe("adopting a room whose roster lacks the person", () => {
    // Ivan makes the room with the person as a member, so its roster lists
    // Ivan alone until the person joins it, which adopting it does.

    const adopting = once(async () => {
      const { person } = await fabric.personWithRooms("hana", 0);
      const ivanIdentity = await Identity.fromPassphrase(
        `fabrichat-room-list ivan ${crypto.randomUUID()}`,
        { implementation: "noble" },
      );
      let room: DID;
      // The room, as Ivan's manager links it.
      let roomCell: Cell<unknown>;
      let rosterBefore: string[];
      const ivan = await openMember(fabric.url, ivanIdentity, 0);
      try {
        room = await fabric.createGroup(ivan, "ivans", "Ivan's room", [
          person.did(),
        ]);
        roomCell = await ivan.home.key("chatManager").key("requests")
          .key("ivans").key("entry").key("room").asSchema<Cell<unknown>>(
            HANDLE,
          ).pull();
        rosterBefore = await rosterOf(ivan.controller, roomCell);
      } finally {
        await closeMember(ivan);
      }

      const profileSpace = await fabric.registerOffered(
        person,
        room,
        ivanIdentity,
        "ivans",
      );

      const client = await fabric.bootClient({ adopt: false, person });
      const stopped = await client.controller.adoptCatalogRooms();
      await fabric.settle(client.controller);
      const [outcome] = await adoptedRooms(client, [room]);

      const second = await fabric.bootClient({ adopt: false, person });
      const secondStopped = await second.controller.adoptCatalogRooms();
      await fabric.settle(second.controller);
      // The documents the room's space delivered to `second` as it adopted.
      const arrivedWhileAdopting = arrivedIn(second, [room]);
      const rosterAfter = await rosterOf(second.controller, roomCell);
      return {
        room,
        roomCell,
        profileSpace,
        rosterBefore,
        client,
        stopped,
        outcome,
        rosterAfter,
        secondStopped,
        arrivedWhileAdopting,
      };
    });

    afterAll(() => fabric.disposeClients());

    it("finds the roster listing Ivan alone before the adoption", async () => {
      const { profileSpace, rosterBefore } = await adopting();
      expect(rosterBefore.length).toBe(1);
      expect(rosterBefore).not.toContain(profileSpace);
    });

    it("records the room's adoption, and stops the room's piece", async () => {
      const { roomCell, client, stopped, outcome } = await adopting();
      const runtime = client.controller.runtime;
      expect(outcome.status).toBe("done");
      expect(
        runtime.runner.isRunning(
          runtime.getCellFromLink(roomCell.getAsNormalizedFullLink()),
        ),
      ).toBe(false);
      // As for the rooms of `fabrichat-room-list-adoption`: under server
      // execution a client starts the room's piece only where its echo of the
      // join reaches the room.
      if (!serving) expect(stopped).toBe(1);
    });

    it("lists the room for the person", async () => {
      const { room, client } = await adopting();
      const rows = await fabric.listRooms(client, 1);
      expect(rows.map((row) => row.room.space)).toContain(room);
    });

    it("leaves the person on the room's roster", async () => {
      const { profileSpace, rosterBefore, rosterAfter } = await adopting();
      expect(rosterAfter).toEqual([...rosterBefore, profileSpace]);
    });

    it("adopts nothing at a later boot, and receives no document from the room's space", async () => {
      const { secondStopped, arrivedWhileAdopting } = await adopting();
      expect(secondStopped).toBe(0);
      expect(arrivedWhileAdopting).toEqual([0]);
    });
  });

  describe("two people adopting one room at once", () => {
    // Ivan makes the room with both as members, and each one's Home lists it
    // with no membership. Both clients adopt it at once, so with server
    // execution off each client's join writes the room's roster, and one of
    // the two commits meets the other's.

    const adopting = once(async () => {
      const people = [await identityNamed("kim"), await identityNamed("lee")];
      for (const person of people) {
        await closeMember(await openMember(fabric.url, person, 0));
      }
      const ivanIdentity = await identityNamed("ivan");
      const ivan = await openMember(fabric.url, ivanIdentity, 0);
      let room: DID;
      let roomCell: Cell<unknown>;
      let rosterBefore: string[];
      try {
        room = await fabric.createGroup(
          ivan,
          "both",
          "Ivan's room for two",
          people.map((person) => person.did()),
        );
        roomCell = await ivan.home.key("chatManager").key("requests")
          .key("both").key("entry").key("room").asSchema<Cell<unknown>>(
            HANDLE,
          ).pull();
        rosterBefore = await rosterOf(ivan.controller, roomCell);
      } finally {
        await closeMember(ivan);
      }
      const profileSpaces: DID[] = [];
      for (const person of people) {
        profileSpaces.push(
          await fabric.registerOffered(person, room, ivanIdentity, "both"),
        );
      }

      const clients = await Promise.all(
        people.map((person) => fabric.bootClient({ adopt: false, person })),
      );
      await Promise.all(
        clients.map((client) => client.controller.adoptCatalogRooms()),
      );
      for (const client of clients) await fabric.settle(client.controller);
      const outcomes = (await Promise.all(
        clients.map((client) => adoptedRooms(client, [room])),
      )).map(([outcome]) => outcome);

      let rosterAfter: string[];
      const reader = await fabric.bootClient({
        adopt: false,
        person: people[0],
      });
      try {
        rosterAfter = await rosterOf(reader.controller, roomCell);
      } finally {
        await fabric.dispose(reader.controller);
      }
      return { rosterBefore, profileSpaces, outcomes, rosterAfter };
    });

    afterAll(() => fabric.disposeClients());

    it("records each one's adoption", async () => {
      const { outcomes } = await adopting();
      expect(outcomes.map(({ status }) => status)).toEqual(["done", "done"]);
    });

    it("leaves both on the room's roster", async () => {
      const { rosterBefore, profileSpaces, rosterAfter } = await adopting();
      expect(rosterBefore.length).toBe(1);
      expect([...rosterAfter].sort()).toEqual(
        [...rosterBefore, ...profileSpaces].sort(),
      );
    });
  });
});
