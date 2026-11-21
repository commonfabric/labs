/**
 * FabriChat offers across runtimes, to people whose profile's inbox pointer
 * finds no `receive` stream, under either server-execution posture. Each person
 * has a Home stand-in with a real profile, which points at a real private inbox
 * or at a piece that takes no offers, and the inbox's space can stop admitting
 * other people, or be deleted, before the sender's runtime has read it. Where a
 * profile points decides nothing the sender records: an add naming such a
 * person reads `offered`, lists them on the room's roster by their profile,
 * and queues no notice for them, and a group naming them lists them too, and
 * still offers the room to its other members. A serving loop reads a space as
 * its OWNER does, so it finds the inbox in a space that no longer admits the
 * sender, and delivers the offer.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  resolveServerExecution,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrichat-labeled-inbox",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/** Whether this run's harness serves handlers from a serving loop. */
const SERVER_EXECUTION = resolveServerExecution();

// The reviewed actions a start and an add are admitted from, as
// `../system/fabrichat/schemas.tsx` names them.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };
const ADD_MEMBER_ACTION = {
  surface: "ChatAddMemberSurface",
  action: "ChatAddMember",
};

/** The address of a cell, as `MultiRuntimeSession.link()` returns one. */
type CellAddress = Awaited<ReturnType<MultiRuntimeSession["link"]>>;

/** A link to `address`, as an event carries one. */
const linkTo = (address: CellAddress) => ({
  "/": {
    "link@1": { id: address.id, path: address.path, space: address.space },
  },
});

/**
 * The id an add to the room in `space` keys its offer by, as
 * `addMemberOfferId()` in `../system/fabrichat/schemas.tsx` composes it.
 */
const addMemberOfferId = (space: string, requestId: string): string =>
  JSON.stringify(["addMember", space, requestId]);

describe("fabrichat offers to an inbox that takes none", () => {
  let harness: MultiRuntimeHarness;
  let ada: MultiRuntimeSession;
  let carol: MultiRuntimeSession;
  let carolInbox: CellAddress;
  let pieceless: MultiRuntimeSession;
  let texted: MultiRuntimeSession;
  let objected: MultiRuntimeSession;
  let marked: MultiRuntimeSession;
  let closed: MultiRuntimeSession;
  let closedInbox: CellAddress;
  let deleted: MultiRuntimeSession;

  /**
   * Gives `sessions`' stand-ins a private inbox each, in a space of its own,
   * which its profile points at, and returns the inboxes' addresses.
   */
  const setUpInboxes = async (
    ...sessions: MultiRuntimeSession[]
  ): Promise<CellAddress[]> => {
    await Promise.all(
      sessions.map((session) => session.send("createInbox", {})),
    );
    await harness.settle();
    await Promise.all(
      sessions.map((session) => session.send("pointInbox", {})),
    );
    await settlePointed(sessions);
    return await Promise.all(
      sessions.map((session) => session.link(["privateInbox", "piece"])),
    );
  };

  /** Settles until each of `sessions`' profiles points at an inbox. */
  const settlePointed = async (
    sessions: readonly MultiRuntimeSession[],
  ): Promise<void> => {
    await harness.settleUntil(async () =>
      (await Promise.all(
        sessions.map((session) =>
          session.read(["profiles", 0, "inbox", "piece"])
        ),
      )).every((piece) => piece !== undefined)
    );
  };

  /** Whether `session`'s `inbox` holds an offer whose id is `offerId`. */
  const inboxHolds = async (
    session: MultiRuntimeSession,
    inbox: CellAddress,
    offerId: string,
  ): Promise<boolean> =>
    ((await session.read(["offers"], { piece: inbox })) as
      | { id: string }[]
      | undefined ?? []).some(({ id }) => id === offerId);

  /** Whether the roster of `room` lists the profile at `profile`. */
  const rosterLists = async (
    room: CellAddress,
    profile: CellAddress,
  ): Promise<boolean> => {
    const length = (await ada.read(["roster", "length"], { piece: room })) as
      | number
      | undefined ?? 0;
    for (let index = 0; index < length; index++) {
      const known = await ada.link(["roster", index], { piece: room });
      if (known.id === profile.id && known.space === profile.space) return true;
    }
    return false;
  };

  /**
   * Whether Ada's manager has a notice waiting for `session`'s person, from
   * the request whose offer's id is `offerId`.
   */
  const noticeWaits = async (
    session: MultiRuntimeSession,
    offerId: string,
  ): Promise<boolean> =>
    ((await ada.read(["chatManager", "outgoingNotices"])) as
      | { id: string }[]
      | undefined ?? []).some(({ id }) =>
        id === JSON.stringify([session.identity.did(), offerId])
      );

  /** Sends Ada's add of `session`'s person to a new room, and returns both. */
  const addToNewRoom = async (
    key: string,
    session: MultiRuntimeSession,
  ): Promise<{ room: CellAddress; requestId: string; offerId: string }> => {
    await ada.send("createGroup", {
      requestId: `room-${key}`,
      title: key,
      members: [],
    }, START_ACTION);
    await harness.settle();
    const room = await ada.link(["requests", `room-${key}`, "entry", "room"]);
    const requestId = `add-${key}`;
    await ada.send(
      "addMember",
      { requestId, profile: linkTo(await session.link(["profiles", 0])) },
      ADD_MEMBER_ACTION,
      { piece: room },
    );
    return {
      room,
      requestId,
      offerId: addMemberOfferId(room.space, requestId),
    };
  };

  /** The `delivery` of Ada's add `requestId` to `room`. */
  const deliveryOf = async (
    requestId: string,
    room: CellAddress,
  ): Promise<unknown> =>
    await ada.read(["$VIEWS", "room", "addRequests", requestId, "delivery"], {
      piece: room,
    });

  /** Ada's new group naming `session`'s person and Carol, once Carol has it. */
  const groupWithCarol = async (
    key: string,
    session: MultiRuntimeSession,
  ): Promise<{ room: CellAddress; requestId: string }> => {
    const carolProfile = await carol.link(["profiles", 0]);
    const requestId = `group-${key}`;
    await ada.send("createGroup", {
      requestId,
      title: key,
      members: [],
      profiles: [
        linkTo(await session.link(["profiles", 0])),
        linkTo(carolProfile),
      ],
    }, START_ACTION);
    await harness.settle();
    const room = await ada.link(["requests", requestId, "entry", "room"]);
    await harness.settleUntil(async () =>
      await inboxHolds(carol, carolInbox, requestId) &&
      await rosterLists(room, carolProfile)
    );
    return { room, requestId };
  };

  /**
   * Expects an add of `session`'s person to read `offered`, to list them on
   * the room's roster, and to queue no notice for them, and returns the add.
   */
  const expectAddListed = async (
    key: string,
    session: MultiRuntimeSession,
  ): Promise<{ room: CellAddress; requestId: string; offerId: string }> => {
    const added = await addToNewRoom(key, session);
    await harness.settleUntil(async () =>
      await rosterLists(added.room, await session.link(["profiles", 0]))
    );
    expect(await deliveryOf(added.requestId, added.room)).toBe("offered");
    expect(await noticeWaits(session, added.offerId)).toBe(false);
    return added;
  };

  /**
   * Expects a group naming `session`'s person and Carol to offer Carol the
   * room, to list `session`'s person on its roster, and to queue no notice
   * for them, and returns the group's request id.
   */
  const expectGroupListed = async (
    key: string,
    session: MultiRuntimeSession,
  ): Promise<string> => {
    const { room, requestId } = await groupWithCarol(key, session);
    await harness.settleUntil(async () =>
      await rosterLists(room, await session.link(["profiles", 0]))
    );
    expect(await noticeWaits(session, requestId)).toBe(false);
    return requestId;
  };

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        "fabrichat-no-stream-ada",
        "fabrichat-no-stream-carol",
        "fabrichat-no-stream-pieceless",
        "fabrichat-no-stream-texted",
        "fabrichat-no-stream-objected",
        "fabrichat-no-stream-marked",
        "fabrichat-no-stream-closed",
        "fabrichat-no-stream-deleted",
      ],
      aclMode: "enforce",
    });
    [ada, carol, pieceless, texted, objected, marked, closed, deleted] =
      harness.sessions;
    // Each step is taken in every session at once, and the sessions then
    // settled together, since one session's step touches only its own spaces.
    const named = [
      [ada, "Ada"],
      [carol, "Carol"],
      [pieceless, "Pieceless"],
      [texted, "Texted"],
      [objected, "Objected"],
      [marked, "Marked"],
      [closed, "Closed"],
      [deleted, "Deleted"],
    ] as const;
    // Ada's stand-in is the piece the harness started; everyone else's is
    // started here.
    await Promise.all(
      named.slice(1).map(([session]) =>
        session.client().call("createPiece", {
          programPath: PROGRAM_PATH,
          rootPath: ROOT_PATH,
        })
      ),
    );
    // A profile named for each person, and each home space's root linked to
    // the stand-in.
    await Promise.all(
      named.map(([session, name]) => session.send("createProfile", { name })),
    );
    await harness.settle();
    await Promise.all(
      named.map(([session]) => session.client().call("linkHomeRoot", {})),
    );
    await harness.settle();

    let deletedInbox: CellAddress;
    [carolInbox, closedInbox, deletedInbox] = await setUpInboxes(
      carol,
      closed,
      deleted,
    );

    // Pieceless's profile points at itself, a piece in a space other than
    // Ada's that has no `receive` stream. Each of the others points at a
    // document of its own, holding what its case names at `receive`.
    const piecelessProfile = await pieceless.link(["profiles", 0]);
    await Promise.all([
      pieceless.send(
        "setInbox",
        { inbox: linkTo(piecelessProfile) },
        undefined,
        { piece: piecelessProfile },
      ),
      ...([
        [texted, "text-at-receive", "plain data"],
        [objected, "object-at-receive", { title: "plain data" }],
        [marked, "stream-at-receive", { $stream: true }],
      ] as const).map(async ([session, cause, receive]) =>
        session.send(
          "setInbox",
          { inbox: await session.createCell(cause, { receive }) },
          undefined,
          { piece: await session.link(["profiles", 0]) },
        )
      ),
    ]);
    await settlePointed([pieceless, texted, objected, marked]);

    await closed.removeFromAccessList(closedInbox.space, "*");
    await deleted.removeFromAccessList(deletedInbox.space, "*");
    await deleted.deleteSpace(deletedInbox.space);
    await harness.settle();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("offers the room to a member whose inbox takes offers", async () => {
    const { room, requestId, offerId } = await addToNewRoom("working", carol);
    await harness.settleUntil(async () =>
      await inboxHolds(carol, carolInbox, offerId) &&
      await rosterLists(room, await carol.link(["profiles", 0]))
    );
    expect(await deliveryOf(requestId, room)).toBe("offered");
    expect(await noticeWaits(carol, offerId)).toBe(false);
  });

  describe("a member whose inbox pointer names a piece with no `receive`", () => {
    it("reads `offered` for an add, and lists them on the roster with no notice", async () => {
      await expectAddListed("pieceless", pieceless);
    });

    it("lists them on a group's roster, and offers the room to its other member", async () => {
      await expectGroupListed("pieceless", pieceless);
    });
  });

  describe("a member whose inbox pointer names text at `receive`", () => {
    it("reads `offered` for an add, and lists them on the roster with no notice", async () => {
      await expectAddListed("texted", texted);
    });

    it("lists them on a group's roster, and offers the room to its other member", async () => {
      await expectGroupListed("texted", texted);
    });
  });

  describe("a member whose inbox pointer names an object at `receive`", () => {
    it("reads `offered` for an add, and lists them on the roster with no notice", async () => {
      await expectAddListed("objected", objected);
    });

    it("lists them on a group's roster, and offers the room to its other member", async () => {
      await expectGroupListed("objected", objected);
    });
  });

  it("reads `offered` for a member whose inbox pointer names a stored stream marker at `receive`", async () => {
    const { room, requestId, offerId } = await addToNewRoom("marked", marked);
    await harness.settleUntil(async () =>
      await rosterLists(room, await marked.link(["profiles", 0]))
    );
    expect(await deliveryOf(requestId, room)).toBe("offered");
    expect(await noticeWaits(marked, offerId)).toBe(false);
  });

  describe("a member whose inbox is in a deleted space", () => {
    it("reads `offered` for an add, and lists them on the roster with no notice", async () => {
      await expectAddListed("deleted", deleted);
    });

    it("lists them on a group's roster, and offers the room to its other member", async () => {
      await expectGroupListed("deleted", deleted);
    });
  });

  describe("a member whose inbox is in a space that doesn't admit the sender", () => {
    it("lists them on the roster for an add, and sends what the runtime running the offer can", async () => {
      const { offerId } = await expectAddListed("closed", closed);
      if (!SERVER_EXECUTION) return;
      await harness.settleUntil(async () =>
        await inboxHolds(closed, closedInbox, offerId)
      );
    });

    it("lists them on a group's roster, and offers the room to its other member", async () => {
      const requestId = await expectGroupListed("closed", closed);
      if (!SERVER_EXECUTION) return;
      await harness.settleUntil(async () =>
        await inboxHolds(closed, closedInbox, requestId)
      );
    });
  });
});
