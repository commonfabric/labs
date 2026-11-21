/**
 * What adopting a room someone offered a person does to the room's roster,
 * when the person's Home registered the offer and its acceptance did not
 * land: the catalog lists the room with no membership, and adopting it puts
 * the person on the roster, once, however many people adopt it at once.
 *
 * Each scenario has fresh people of its own. `fabrichat-room-list-fixture.ts`
 * holds the server and clients the `fabrichat-room-list-*` files share.
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import { Identity } from "@commonfabric/identity";
import type { Cell } from "@commonfabric/runner";
import { closeMember, openMember } from "./fabrichat-room-fixture.ts";
import {
  adoptedRooms,
  arrivedIn,
  type Client,
  HANDLE,
  identityNamed,
  RoomListServer,
  rosterOf,
  serving,
} from "./fabrichat-room-list-fixture.ts";

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

    let person: Identity;
    let room: DID;

    /** The room, as Ivan's manager links it. */
    let roomCell: Cell<unknown>;

    let profileSpace: DID;
    let rosterBefore: string[];
    let client: Client;
    let stopped: number;
    let outcome: { status?: string; room?: Cell<unknown> };
    let rosterAfter: string[];
    let second: Client;
    let secondStopped: number;

    /** The documents the room's space delivered to `second` as it adopted. */
    let arrivedWhileAdopting: number[];

    beforeAll(async () => {
      const made = await fabric.personWithRooms("hana", 0);
      person = made.person;
      const ivanIdentity = await Identity.fromPassphrase(
        `fabrichat-room-list ivan ${crypto.randomUUID()}`,
        { implementation: "noble" },
      );
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

      profileSpace = await fabric.registerOffered(
        person,
        room,
        ivanIdentity,
        "ivans",
      );

      client = await fabric.bootClient({ adopt: false, person });
      stopped = await client.controller.adoptCatalogRooms();
      await fabric.settle(client.controller);
      [outcome] = await adoptedRooms(client, [room]);

      second = await fabric.bootClient({ adopt: false, person });
      secondStopped = await second.controller.adoptCatalogRooms();
      await fabric.settle(second.controller);
      arrivedWhileAdopting = arrivedIn(second, [room]);
      rosterAfter = await rosterOf(second.controller, roomCell);
    });

    afterAll(async () => {
      await client?.controller.dispose();
      await second?.controller.dispose();
    });

    it("finds the roster listing Ivan alone before the adoption", () => {
      expect(rosterBefore.length).toBe(1);
      expect(rosterBefore).not.toContain(profileSpace);
    });

    it("records the room's adoption, and stops the room's piece", () => {
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
      const rows = await fabric.listRooms(client, 1);
      expect(rows.map((row) => row.room.space)).toContain(room);
    });

    it("leaves the person on the room's roster", () => {
      expect(rosterAfter).toEqual([...rosterBefore, profileSpace]);
    });

    it("adopts nothing at a later boot, and receives no document from the room's space", () => {
      expect(secondStopped).toBe(0);
      expect(arrivedWhileAdopting).toEqual([0]);
    });
  });

  describe("two people adopting one room at once", () => {
    // Ivan makes the room with both as members, and each one's Home lists it
    // with no membership. Both clients adopt it at once, so with server
    // execution off each client's join writes the room's roster, and one of
    // the two commits meets the other's.

    let rosterBefore: string[];
    let profileSpaces: DID[];
    let clients: Client[];
    let outcomes: { status?: string }[];
    let rosterAfter: string[];

    beforeAll(async () => {
      const people = [await identityNamed("kim"), await identityNamed("lee")];
      for (const person of people) {
        await closeMember(await openMember(fabric.url, person, 0));
      }
      const ivanIdentity = await identityNamed("ivan");
      const ivan = await openMember(fabric.url, ivanIdentity, 0);
      let room: DID;
      let roomCell: Cell<unknown>;
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
      profileSpaces = [];
      for (const person of people) {
        profileSpaces.push(
          await fabric.registerOffered(person, room, ivanIdentity, "both"),
        );
      }

      clients = await Promise.all(
        people.map((person) => fabric.bootClient({ adopt: false, person })),
      );
      await Promise.all(
        clients.map((client) => client.controller.adoptCatalogRooms()),
      );
      for (const client of clients) await fabric.settle(client.controller);
      outcomes = (await Promise.all(
        clients.map((client) => adoptedRooms(client, [room])),
      )).map(([outcome]) => outcome);

      const reader = await fabric.bootClient({
        adopt: false,
        person: people[0],
      });
      try {
        rosterAfter = await rosterOf(reader.controller, roomCell);
      } finally {
        await reader.controller.dispose();
      }
    });

    afterAll(async () => {
      for (const client of clients ?? []) await client.controller.dispose();
    });

    it("records each one's adoption", () => {
      expect(outcomes.map(({ status }) => status)).toEqual(["done", "done"]);
    });

    it("leaves both on the room's roster", () => {
      expect(rosterBefore.length).toBe(1);
      expect([...rosterAfter].sort()).toEqual(
        [...rosterBefore, ...profileSpaces].sort(),
      );
    });
  });
});
