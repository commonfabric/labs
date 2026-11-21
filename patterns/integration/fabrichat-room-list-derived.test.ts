/**
 * What a fresh client of a person's Home loads in the spaces of the person's
 * FabriChat rooms once another client of the person's has derived what reads
 * the rooms: nothing. A client loads a room's documents when a read of its
 * reaches the room, and its bring-up names nothing a node reads past a link
 * into another space, so what the manager's view or its `people` declare of
 * the rooms is read only by whoever reads them.
 *
 * Each scenario has a fresh person keep rooms of their own.
 * `fabrichat-room-list-fixture.ts` holds the server and clients the
 * `fabrichat-room-list-*` files share.
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import { Identity } from "@commonfabric/identity";
import type { Cell } from "@commonfabric/runner";
import {
  CHAT_START,
  closeMember,
  directRoomLabel,
  openMember,
  sendTrusted,
} from "./fabrichat-room-fixture.ts";
import {
  arrivedIn,
  type Client,
  crossSpaceReads,
  HANDLE,
  heldIn,
  openedOf,
  RoomListServer,
  serving,
} from "./fabrichat-room-list-fixture.ts";

describe("fabrichat-room-list-derived", () => {
  let fabric: RoomListServer;

  beforeAll(async () => {
    fabric = await RoomListServer.start();
  });

  afterAll(async () => {
    await fabric?.close();
  });

  describe("a fresh client once another has rendered the manager's view", () => {
    let rooms: DID[];
    let linked: Set<string>;
    let client: Client;

    beforeAll(async () => {
      const made = await fabric.personWithRooms("dana", 2);
      rooms = made.rooms;
      const renderer = await fabric.bootClient({ person: made.person });
      try {
        ({ linked } = await fabric.renderManagerView(renderer));
      } finally {
        await renderer.controller.dispose();
      }
      client = await fabric.bootClient({ person: made.person });
      await fabric.listRooms(client, rooms.length);
    });

    afterAll(async () => {
      await client?.controller.dispose();
    });

    it("finds the rendered view linking each room", () => {
      expect(rooms.filter((space) => linked.has(space))).toEqual(rooms);
    });

    it("receives no document from any room's space, from bring-up on", () => {
      expect(arrivedIn(client, rooms)).toEqual(rooms.map(() => 0));
      expect(heldIn(client, rooms)).toEqual(rooms.map(() => 0));
    });

    it("opens no session to any room's space, from bring-up on", () => {
      expect(openedOf(client, rooms)).toEqual([]);
    });
  });

  describe("a direct room with a counterpart whose profile is named", () => {
    let counterpart: Identity;
    let room: DID;
    let profileSpace: DID;
    let rosterNamesThem: boolean;
    let labels: string[];
    let renderedOpened: DID[];
    let renderedArrived: number[];
    let client: Client;

    beforeAll(async () => {
      // The counterpart has a Home and a named profile, and the person starts
      // the room naming that profile, which puts it on the room's roster: a
      // label read from the roster, or from the profile, would find their
      // name there, by reading the room's space and the profile's.
      const made = await fabric.personWithRooms("erin", 0);
      counterpart = await Identity.fromPassphrase(
        `fabrichat-room-list fay ${crypto.randomUUID()}`,
        { implementation: "noble" },
      );
      const theirs = await openMember(fabric.url, counterpart, 1);
      let profile: Cell<unknown>;
      try {
        profile = await theirs.home.key("profiles").key(0)
          .asSchema<Cell<unknown>>({ asCell: ["cell"] }).pull();
      } finally {
        await closeMember(theirs);
      }
      profileSpace = profile.space as DID;
      const member = await openMember(fabric.url, made.person, 0);
      try {
        const manager = member.home.key("chatManager");
        await sendTrusted(member.controller, manager.key("openDirect"), {
          requestId: "direct-fay",
          counterpart: counterpart.did(),
          profile: member.controller.runtime.getCellFromLink(
            profile.getAsNormalizedFullLink(),
          ),
        }, CHAT_START);
        const outcome = await member.waits.until(
          "the direct room with Fay",
          manager.key("requests").key("direct-fay") as Cell<
            { status?: string; reason?: string } | undefined
          >,
          (value) => value?.status !== undefined,
        );
        if (outcome.status !== "done") {
          throw new Error(`The manager refused the room: ${outcome.reason}`);
        }
        await fabric.settle(member.controller);
        const link = await manager.key("requests").key("direct-fay")
          .key("entry").key("room").asSchema<Cell<unknown>>(HANDLE).pull();
        room = link.space as DID;
        const roster = await member.waits.until(
          "the room's roster listing Fay's profile",
          link.key("roster").asSchema<Cell<unknown>[]>({
            type: "array",
            items: { asCell: ["cell"] },
          }),
          (value) =>
            (value ?? []).some((entry) => entry.space === profileSpace),
        );
        rosterNamesThem = roster.some((entry) => entry.space === profileSpace);
      } finally {
        await closeMember(member);
      }
      const renderer = await fabric.bootClient({ person: made.person });
      try {
        await fabric.listRooms(renderer, 1);
        ({ labels } = await fabric.renderManagerView(renderer));
        renderedOpened = openedOf(renderer, [profileSpace]);
        renderedArrived = arrivedIn(renderer, [profileSpace]);
      } finally {
        await renderer.controller.dispose();
      }
      client = await fabric.bootClient({ person: made.person });
      await fabric.listRooms(client, 1);
    });

    afterAll(async () => {
      await client?.controller.dispose();
    });

    it("finds the room's roster listing the counterpart's profile", () => {
      expect(rosterNamesThem).toBe(true);
    });

    it("labels the room with the counterpart's principal, shortened", () => {
      expect(labels).toEqual([directRoomLabel(counterpart.did())]);
    });

    it("receives no document from the counterpart's profile space while it renders the list", () => {
      expect(renderedArrived).toEqual([0]);
    });

    it("opens no session to the counterpart's profile space while it renders the list", () => {
      expect(renderedOpened).toEqual([]);
    });

    it("lists the room in a fresh client without receiving a document from either space", () => {
      expect(arrivedIn(client, [room, profileSpace])).toEqual([0, 0]);
    });

    it("lists the room in a fresh client without opening a session to either space", () => {
      expect(openedOf(client, [room, profileSpace])).toEqual([]);
    });
  });

  describe("a fresh client once another has read the people list", () => {
    let rooms: DID[];
    let reader: Client;
    let client: Client;

    /** The plan reads the resume pre-sync's cross-space pass made. */
    let crossSpaceReadsAtBringUp: number;

    beforeAll(async () => {
      const made = await fabric.personWithRooms("carol", 2);
      rooms = made.rooms;
      reader = await fabric.bootClient({ person: made.person });
      try {
        const people = reader.home.key("chatManager").key("people").asSchema({
          type: "object",
          additionalProperties: { type: "array", items: HANDLE },
        });
        people.sink(() => {});
        await people.pull();
        await fabric.settle(reader.controller);
      } finally {
        await reader.controller.dispose();
      }
      const before = crossSpaceReads();
      client = await fabric.bootClient({ person: made.person });
      await fabric.listRooms(client, rooms.length);
      crossSpaceReadsAtBringUp = crossSpaceReads() - before;
    });

    afterAll(async () => {
      await client?.controller.dispose();
    });

    it("finds the people list reading each room's roster", () => {
      // Under server execution the serving loop reads the rosters, and the
      // reader holds what it derived from them.
      if (serving) return;
      expect(
        rooms.filter((space) => (reader.arrived.get(space)?.size ?? 0) > 0),
      )
        .toEqual(rooms);
    });

    it("receives no document from any room's space, from bring-up on", () => {
      expect(arrivedIn(client, rooms)).toEqual(rooms.map(() => 0));
      expect(heldIn(client, rooms)).toEqual(rooms.map(() => 0));
    });

    it("opens no session to any room's space, from bring-up on", () => {
      expect(openedOf(client, rooms)).toEqual([]);
    });

    it("runs no cross-space pass while it brings Home up", () => {
      // The serving loop runs in this process under server execution, and
      // its pass is counted with the clients'.
      if (serving) return;
      expect(crossSpaceReadsAtBringUp).toBe(0);
    });
  });
});
