/**
 * What a fresh client of a person's Home loads in the spaces of the person's
 * FabriChat rooms once another client of the person's has derived what reads
 * the rooms: nothing. A client loads a room's documents when a read of its
 * reaches the room, and its bring-up names nothing a node reads past a link
 * into another space, so what the manager's view or its `people` declare of
 * the rooms is read only by whoever reads them. Once another client has
 * archived a container whose chat the person joined, a fresh client leaves
 * the chat out, and still loads nothing in the container's space.
 *
 * Each scenario has a fresh person keep rooms of their own, and is set up when
 * the first of its tests reads it.
 * `fabrichat-room-list-fixture.ts` holds the server and clients the
 * `fabrichat-room-list-*` files share.
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import { Identity } from "@commonfabric/identity";
import { type Cell, normalizeSpaceHost } from "@commonfabric/runner";
import { sendVerbEvent } from "@commonfabric/piece/verb-call";
import {
  CHAT_START,
  closeMember,
  directRoomLabel,
  openMember,
  sendTrusted,
} from "./fabrichat-room-fixture.ts";
import {
  arrivedIn,
  crossSpaceReads,
  HANDLE,
  heldIn,
  openedOf,
  RoomListServer,
  ROW,
  type Row,
  serving,
} from "./fabrichat-room-list-fixture.ts";
import { once } from "./multi-runtime-harness.ts";

describe("fabrichat-room-list-derived", () => {
  let fabric: RoomListServer;

  beforeAll(async () => {
    fabric = await RoomListServer.start();
  });

  afterAll(async () => {
    await fabric?.close();
  });

  describe("a fresh client once another has rendered the manager's view", () => {
    const rendered = once(async () => {
      const { person, rooms } = await fabric.personWithRooms("dana", 2);
      let linked: Set<string>;
      const renderer = await fabric.bootClient({ person });
      try {
        ({ linked } = await fabric.renderManagerView(renderer));
      } finally {
        await fabric.dispose(renderer.controller);
      }
      const client = await fabric.bootClient({ person });
      await fabric.listRooms(client, rooms.length);
      return { rooms, linked, client };
    });

    afterAll(() => fabric.disposeClients());

    it("finds the rendered view linking each room", async () => {
      const { rooms, linked } = await rendered();
      expect(rooms.filter((space) => linked.has(space))).toEqual(rooms);
    });

    it("receives no document from any room's space, from bring-up on", async () => {
      const { rooms, client } = await rendered();
      expect(arrivedIn(client, rooms)).toEqual(rooms.map(() => 0));
      expect(heldIn(client, rooms)).toEqual(rooms.map(() => 0));
    });

    it("opens no session to any room's space, from bring-up on", async () => {
      const { rooms, client } = await rendered();
      expect(openedOf(client, rooms)).toEqual([]);
    });
  });

  describe("a direct room with a counterpart whose profile is named", () => {
    const labeled = once(async () => {
      // The counterpart has a Home and a named profile, and the person starts
      // the room naming that profile, which puts it on the room's roster: a
      // label read from the roster, or from the profile, would find their
      // name there, by reading the room's space and the profile's.
      const made = await fabric.personWithRooms("erin", 0);
      const counterpart = await Identity.fromPassphrase(
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
      const profileSpace = profile.space as DID;
      let room: DID;
      let rosterNamesThem: boolean;
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
      let labels: string[];
      let renderedOpened: DID[];
      let renderedArrived: number[];
      const renderer = await fabric.bootClient({ person: made.person });
      try {
        await fabric.listRooms(renderer, 1);
        ({ labels } = await fabric.renderManagerView(renderer));
        renderedOpened = openedOf(renderer, [profileSpace]);
        renderedArrived = arrivedIn(renderer, [profileSpace]);
      } finally {
        await fabric.dispose(renderer.controller);
      }
      const client = await fabric.bootClient({ person: made.person });
      await fabric.listRooms(client, 1);
      return {
        counterpart,
        room,
        profileSpace,
        rosterNamesThem,
        labels,
        renderedOpened,
        renderedArrived,
        client,
      };
    });

    afterAll(() => fabric.disposeClients());

    it("finds the room's roster listing the counterpart's profile", async () => {
      const { rosterNamesThem } = await labeled();
      expect(rosterNamesThem).toBe(true);
    });

    it("labels the room with the counterpart's principal, shortened", async () => {
      const { counterpart, labels } = await labeled();
      expect(labels).toEqual([directRoomLabel(counterpart.did())]);
    });

    it("receives no document from the counterpart's profile space while it renders the list", async () => {
      const { renderedArrived } = await labeled();
      expect(renderedArrived).toEqual([0]);
    });

    it("opens no session to the counterpart's profile space while it renders the list", async () => {
      const { renderedOpened } = await labeled();
      expect(renderedOpened).toEqual([]);
    });

    it("lists the room in a fresh client without receiving a document from either space", async () => {
      const { room, profileSpace, client } = await labeled();
      expect(arrivedIn(client, [room, profileSpace])).toEqual([0, 0]);
    });

    it("lists the room in a fresh client without opening a session to either space", async () => {
      const { room, profileSpace, client } = await labeled();
      expect(openedOf(client, [room, profileSpace])).toEqual([]);
    });
  });

  describe("a fresh client once another has read the people list", () => {
    const read = once(async () => {
      const { person, rooms } = await fabric.personWithRooms("carol", 2);
      const reader = await fabric.bootClient({ person });
      try {
        // The people list names no one, and reads no roster, until the
        // session asks for it.
        await sendVerbEvent(
          reader.home.key("chatManager").key("askForPeople"),
          {},
        );
        const people = reader.home.key("chatManager").key("people").asSchema({
          type: "object",
          additionalProperties: { type: "array", items: HANDLE },
        });
        people.sink(() => {});
        await people.pull();
        await fabric.settle(reader.controller);
      } finally {
        await fabric.dispose(reader.controller);
      }
      const before = crossSpaceReads();
      const client = await fabric.bootClient({ person });
      await fabric.listRooms(client, rooms.length);
      // The plan reads the resume pre-sync's cross-space pass made.
      const crossSpaceReadsAtBringUp = crossSpaceReads() - before;
      return { rooms, reader, client, crossSpaceReadsAtBringUp };
    });

    afterAll(() => fabric.disposeClients());

    it("finds the people list reading each room's roster", async () => {
      // Under server execution the serving loop reads the rosters, and the
      // reader holds what it derived from them.
      if (serving) return;
      const { rooms, reader } = await read();
      expect(
        rooms.filter((space) => (reader.arrived.get(space)?.size ?? 0) > 0),
      )
        .toEqual(rooms);
    });

    it("receives no document from any room's space, from bring-up on", async () => {
      const { rooms, client } = await read();
      expect(arrivedIn(client, rooms)).toEqual(rooms.map(() => 0));
      expect(heldIn(client, rooms)).toEqual(rooms.map(() => 0));
    });

    it("opens no session to any room's space, from bring-up on", async () => {
      const { rooms, client } = await read();
      expect(openedOf(client, rooms)).toEqual([]);
    });

    it("runs no cross-space pass while it brings Home up", async () => {
      // The serving loop runs in this process under server execution, and
      // its pass is counted with the clients'.
      if (serving) return;
      const { crossSpaceReadsAtBringUp } = await read();
      expect(crossSpaceReadsAtBringUp).toBe(0);
    });
  });

  describe("a container's conversation once the catalog archives its container", () => {
    // Nia keeps a room of her own, and joins the chat a container declares in
    // its own space, as a loom's chat is, which her catalog lists under the
    // `loom` kind. She then archives the container in her catalog.

    const archiving = once(async () => {
      const made = await fabric.personWithRooms("nia", 1);
      const ownRoom = made.rooms[0];
      let containerSpace: DID;
      // The spaces of the rooms her manager listed before the archive.
      let listedBefore: DID[];
      const member = await openMember(fabric.url, made.person, 0);
      try {
        const runtime = member.controller.runtime;
        containerSpace = await runtime.createSpace({});
        const tx = runtime.edit();
        const room = runtime.getCell(
          containerSpace,
          "declared conversation",
          undefined,
          tx,
        );
        room.set({ about: { kind: "group", title: "Workshop chat" } });
        const container = runtime.getCell<Record<string, unknown>>(
          containerSpace,
          "container",
          undefined,
          tx,
        );
        container.set({ chatRoom: room });
        runtime.getSpaceCell(containerSpace, undefined, tx).key(
          "defaultPattern",
        ).set(container);
        const { error } = await tx.commit().settled;
        if (error) throw new Error(`Making the container: ${error.message}`);

        const registered = await sendVerbEvent(
          member.home.key("registerSharedSpace"),
          {
            space: containerSpace,
            host: normalizeSpaceHost(new URL(runtime.apiUrl).origin).origin,
            kind: "loom",
            title: "Workshop",
          },
        );
        if (registered.status !== "committed") {
          throw new Error("Registering the container did not commit");
        }
        const manager = member.home.key("chatManager");
        await sendVerbEvent(manager.key("joinRoom"), {
          room,
          container,
          requestId: "nia-join",
        });
        const joined = await member.waits.until(
          "the join of the container's chat",
          manager.key("requests").key("nia-join") as Cell<
            { status?: string; reason?: string } | undefined
          >,
          (value) => value?.status !== undefined,
        );
        if (joined.status !== "done") {
          throw new Error(`The manager refused the join: ${joined.reason}`);
        }
        await fabric.settle(member.controller);
        const listed = await member.waits.until(
          "a list holding the container's chat",
          manager.key("rooms").asSchema<Row[]>({ type: "array", items: ROW }),
          (value) => (value?.length ?? 0) >= 2,
        );
        listedBefore = listed.map((row) => row.room.space as DID);

        const revision = await manager.key("sharedSpaceCatalog").key("entries")
          .key(containerSpace).key("revision").asSchema<string>({
            type: "string",
          }).pull();
        const archived = await sendVerbEvent(
          member.home.key("changeSharedSpaceMembership"),
          {
            space: containerSpace,
            id: "nia-archive",
            expectedRevision: revision,
            state: "archived",
          },
        );
        if (archived.status !== "committed") {
          throw new Error("Archiving the container did not commit");
        }
        await fabric.settle(member.controller);
      } finally {
        await closeMember(member);
      }
      const client = await fabric.bootClient({ person: made.person });
      const rows = await fabric.listRooms(client, 1);
      return { ownRoom, containerSpace, listedBefore, client, rows };
    });

    afterAll(() => fabric.disposeClients());

    it("lists the container's chat before the container is archived", async () => {
      const { ownRoom, containerSpace, listedBefore } = await archiving();
      expect(listedBefore.sort()).toEqual([ownRoom, containerSpace].sort());
    });

    it("lists only the person's own room once the container is archived", async () => {
      const { ownRoom, rows } = await archiving();
      expect(rows.map((row) => row.room.space)).toEqual([ownRoom]);
    });

    it("opens no session to the container's space, and receives no document from it", async () => {
      const { containerSpace, client } = await archiving();
      expect(openedOf(client, [containerSpace])).toEqual([]);
      expect(arrivedIn(client, [containerSpace])).toEqual([0]);
    });
  });
});
