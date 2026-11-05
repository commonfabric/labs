/**
 * FabriChat offers across runtimes, to people whose profile's inbox pointer
 * finds no `receive` stream, under either server-execution posture. Each person
 * has a Home stand-in with a real profile, which points at a real private inbox
 * or at a piece that takes no offers, and the inbox's space can stop admitting
 * other people, or be deleted, before the sender's runtime has read it. An add
 * naming such a person reads `noticed`, with a notice for them, and a group
 * naming them still offers the room to its other members. A serving loop reads
 * a space as its OWNER does, so it finds the inbox in a space that no longer
 * admits the sender, and delivers the offer.
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
   * Gives `session`'s stand-in a profile named `name`, and links the session's
   * home space's root to the stand-in.
   */
  const setUpHome = async (
    session: MultiRuntimeSession,
    name: string,
  ): Promise<void> => {
    await session.send("createProfile", { name });
    await harness.settle();
    await session.client().call("linkHomeRoot", {});
    await harness.settle();
  };

  /**
   * Gives `session`'s stand-in a private inbox in a space of its own, which
   * its profile points at, and returns the inbox's address.
   */
  const setUpInbox = async (
    session: MultiRuntimeSession,
  ): Promise<CellAddress> => {
    await session.send("createInbox", {});
    await harness.settle();
    await session.send("pointInbox", {});
    await harness.settleUntil(async () =>
      (await session.read(["profiles", 0, "inbox", "piece"])) !== undefined
    );
    return await session.link(["privateInbox", "piece"]);
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

  /** Expects an add of `session`'s person to read `noticed`, with a notice. */
  const expectAddNoticed = async (
    key: string,
    session: MultiRuntimeSession,
  ): Promise<void> => {
    const { room, requestId, offerId } = await addToNewRoom(key, session);
    await harness.settleUntil(async () =>
      await deliveryOf(requestId, room) === "noticed"
    );
    expect(await noticeWaits(session, offerId)).toBe(true);
    expect(await rosterLists(room, await session.link(["profiles", 0])))
      .toBe(false);
  };

  /**
   * Expects a group naming `session`'s person and Carol to offer Carol the
   * room, and to leave a notice for `session`'s person.
   */
  const expectGroupNoticed = async (
    key: string,
    session: MultiRuntimeSession,
  ): Promise<void> => {
    const { room, requestId } = await groupWithCarol(key, session);
    expect(await noticeWaits(session, requestId)).toBe(true);
    expect(await rosterLists(room, await session.link(["profiles", 0])))
      .toBe(false);
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
    await setUpHome(ada, "Ada");
    for (
      const [session, name] of [
        [carol, "Carol"],
        [pieceless, "Pieceless"],
        [texted, "Texted"],
        [objected, "Objected"],
        [marked, "Marked"],
        [closed, "Closed"],
        [deleted, "Deleted"],
      ] as const
    ) {
      await session.client().call("createPiece", {
        programPath: PROGRAM_PATH,
        rootPath: ROOT_PATH,
      });
      await setUpHome(session, name);
    }
    carolInbox = await setUpInbox(carol);

    // The profile points at itself, a piece in a space other than Ada's that
    // has no `receive` stream.
    const profile = await pieceless.link(["profiles", 0]);
    await pieceless.send(
      "setInbox",
      { inbox: linkTo(profile) },
      undefined,
      { piece: profile },
    );
    await harness.settleUntil(async () =>
      (await pieceless.read(["profiles", 0, "inbox", "piece"])) !== undefined
    );

    // Each profile points at a document of its own, holding what its case names
    // at `receive`.
    for (
      const [session, cause, receive] of [
        [texted, "text-at-receive", "plain data"],
        [objected, "object-at-receive", { title: "plain data" }],
        [marked, "stream-at-receive", { $stream: true }],
      ] as const
    ) {
      await session.send(
        "setInbox",
        { inbox: await session.createCell(cause, { receive }) },
        undefined,
        { piece: await session.link(["profiles", 0]) },
      );
      await harness.settleUntil(async () =>
        (await session.read(["profiles", 0, "inbox", "piece"])) !== undefined
      );
    }

    closedInbox = await setUpInbox(closed);
    await closed.removeFromAccessList(closedInbox.space, "*");
    await harness.settle();

    const deletedInbox = await setUpInbox(deleted);
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
    it("reads `noticed` for an add, with a notice for them", async () => {
      await expectAddNoticed("pieceless", pieceless);
    });

    it("leaves a group's other member offered the room", async () => {
      await expectGroupNoticed("pieceless", pieceless);
    });
  });

  describe("a member whose inbox pointer names text at `receive`", () => {
    it("reads `noticed` for an add, with a notice for them", async () => {
      await expectAddNoticed("texted", texted);
    });

    it("leaves a group's other member offered the room", async () => {
      await expectGroupNoticed("texted", texted);
    });
  });

  describe("a member whose inbox pointer names an object at `receive`", () => {
    it("reads `noticed` for an add, with a notice for them", async () => {
      await expectAddNoticed("objected", objected);
    });

    it("leaves a group's other member offered the room", async () => {
      await expectGroupNoticed("objected", objected);
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
    it("reads `noticed` for an add, with a notice for them", async () => {
      await expectAddNoticed("deleted", deleted);
    });

    it("leaves a group's other member offered the room", async () => {
      await expectGroupNoticed("deleted", deleted);
    });
  });

  describe("a member whose inbox is in a space that doesn't admit the sender", () => {
    it("reads what the runtime running the offer can do, for an add", async () => {
      if (!SERVER_EXECUTION) {
        await expectAddNoticed("closed", closed);
        return;
      }
      const { room, requestId, offerId } = await addToNewRoom("closed", closed);
      await harness.settleUntil(async () =>
        await inboxHolds(closed, closedInbox, offerId)
      );
      expect(await deliveryOf(requestId, room)).toBe("offered");
      expect(await noticeWaits(closed, offerId)).toBe(false);
    });

    it("leaves a group's other member offered the room", async () => {
      if (!SERVER_EXECUTION) {
        await expectGroupNoticed("closed", closed);
        return;
      }
      const { requestId } = await groupWithCarol("closed", closed);
      await harness.settleUntil(async () =>
        await inboxHolds(closed, closedInbox, requestId)
      );
      expect(await noticeWaits(closed, requestId)).toBe(false);
    });
  });
});
