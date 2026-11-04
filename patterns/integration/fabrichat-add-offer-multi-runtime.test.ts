/**
 * A FabriChat room's add, told to the person added through the adder's own
 * manager, across runtimes and under either server-execution posture. Ada and
 * Grace each have a Home stand-in, which holds their profile, their private
 * inbox, and their FabriChat manager, and which their home space's root links,
 * so that a room's `#chatManager` wish resolves there. Ada's manager offers
 * Grace a group through her profile, which puts her on its roster and among
 * Ada's people. Ada then adds Grace to a second group, from its `addMember`,
 * by address alone: her manager offers Grace that room through the profile it
 * lists for her, and the room's `addRequests`, read through the room, merges
 * the verdict from Ada's home. Grace, a member of the room now, reads none of
 * Ada's adds. An add naming Grace's profile reaches her inbox in either posture,
 * through a pointer document as a link write stores one, and through one whose
 * envelope holds a copy of her inbox's label beneath its slot.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  resolveServerExecution,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrichat-add-offer",
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

/**
 * The id an add to the room in `space` keys its offer by, as
 * `addMemberOfferId()` in `../system/fabrichat/schemas.tsx` composes it.
 */
const addMemberOfferId = (space: string, requestId: string): string =>
  JSON.stringify(["addMember", space, requestId]);

/** A link to `address`, as an event carries one. */
const linkTo = (address: { id: string; space: string; path: string[] }) => ({
  "/": {
    "link@1": { id: address.id, path: address.path, space: address.space },
  },
});

describe("fabrichat add offer across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let ada: MultiRuntimeSession;
  let grace: MultiRuntimeSession;

  /** Whether Grace's private inbox holds an offer whose id is `offerId`. */
  const graceHolds = async (offerId: string): Promise<boolean> => {
    const inbox = await grace.link(["privateInbox", "piece"]);
    return ((await grace.read(["offers"], { piece: inbox })) as
      | { id: string }[]
      | undefined ?? []).some(({ id }) => id === offerId);
  };

  /**
   * Sends Ada's add of Grace to `room`, by her profile, waits for its verdict,
   * and holds the send to the posture: under server execution a fired event
   * travels as an append for the serving loop, and otherwise as none.
   */
  const addByProfile = async (
    requestId: string,
    room: Awaited<ReturnType<MultiRuntimeSession["link"]>>,
  ): Promise<void> => {
    const profile = await grace.link(["profiles", 0]);
    const admitted = await harness.admittedCommitsDuring(async () => {
      await ada.send(
        "addMember",
        { requestId, profile: linkTo(profile) },
        ADD_MEMBER_ACTION,
        { piece: room },
      );
      await harness.settleUntil(async () =>
        (await ada.read(
          ["$VIEWS", "room", "addRequests", requestId, "delivery"],
          { piece: room },
        )) !== undefined
      );
    });
    expect(
      admitted.some((commit) => (commit.eventAppends?.length ?? 0) > 0),
    ).toBe(SERVER_EXECUTION);
    expect(
      await ada.read(["$VIEWS", "room", "addRequests", requestId], {
        piece: room,
      }),
    ).toEqual({ status: "done", delivery: "offered" });
  };

  /**
   * Gives `session`'s stand-in a profile named `name`, and the private inbox
   * the profile points at, and links the session's home space's root to the
   * stand-in.
   */
  async function setUpHome(
    session: MultiRuntimeSession,
    name: string,
  ): Promise<void> {
    await session.send("createProfile", { name });
    await harness.settle();
    await session.client().call("ensurePrivateInbox", { path: [] });
    await harness.settleUntil(async () =>
      (await session.read(["profiles", 0, "inbox", "piece"])) !== undefined
    );
    await session.client().call("linkHomeRoot", {});
    await harness.settle();
  }

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: ["fabrichat-add-offer-ada", "fabrichat-add-offer-grace"],
      aclMode: "enforce",
    });
    [ada, grace] = harness.sessions;
    // Grace's stand-in is a piece of her own, which becomes her session's.
    await grace.client().call("createPiece", {
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
    });
    await setUpHome(ada, "Ada");
    await setUpHome(grace, "Grace");
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("offers a room to someone its owner adds by address, and keeps the adder's outcomes to the adder", async () => {
    const graceProfile = await grace.link(["profiles", 0]);

    // A group offered to Grace through her profile puts her on its roster,
    // and so among Ada's people.
    await ada.send("createGroup", {
      requestId: "g-met",
      title: "Met",
      members: [],
      profiles: [linkTo(graceProfile)],
    }, START_ACTION);
    await harness.settle();
    expect(await ada.read(["requests", "g-met", "status"])).toBe("done");

    // A group of Ada's alone, to which she adds Grace by her profile.
    await ada.send("createGroup", {
      requestId: "g-named",
      title: "Named",
      members: [],
    }, START_ACTION);
    await harness.settle();
    const named = await ada.link(["requests", "g-named", "entry", "room"]);
    await addByProfile("add-named", named);
    await harness.settleUntil(() =>
      graceHolds(addMemberOfferId(named.space, "add-named"))
    );

    // A second group, of Ada's alone.
    await ada.send("createGroup", {
      requestId: "g-added",
      title: "Added",
      members: [],
    }, START_ACTION);
    await harness.settle();
    const room = await ada.link(["requests", "g-added", "entry", "room"]);

    // Ada adds Grace by her address alone. Her manager offers Grace the room
    // through the profile it lists for her, and the room reads the verdict.
    // Under server execution the served offer reads `people` as a runtime of
    // Ada's has derived it, and no session here derives her rooms, so it finds
    // no profile for Grace, and queues a notice instead.
    // TODO(danfuzz): Expect `offered` under server execution too, once a
    // served run derives what it reads.
    await ada.send(
      "addMember",
      {
        requestId: "add-grace",
        target: { value: grace.identity.did() },
      },
      ADD_MEMBER_ACTION,
      { piece: room },
    );
    await harness.settleUntil(async () =>
      (await ada.read(
        ["$VIEWS", "room", "addRequests", "add-grace", "delivery"],
        { piece: room },
      )) !== undefined
    );
    expect(
      await ada.read(["$VIEWS", "room", "addRequests", "add-grace"], {
        piece: room,
      }),
    ).toEqual({
      status: "done",
      delivery: SERVER_EXECUTION ? "noticed" : "offered",
    });

    // The offer reached the inbox Grace's profile points at, keyed by the room
    // and the add.
    if (!SERVER_EXECUTION) {
      await harness.settleUntil(() =>
        graceHolds(addMemberOfferId(room.space, "add-grace"))
      );
    }

    // Grace, a member of the room now, reads it, and none of Ada's adds. Her
    // runtime reached the room's space before the add admitted her and
    // retains that refusal; with one connection per space the refused open
    // closed the connection the server's `session/admissible` hint would
    // ride, so it retries the space as her shell's Retry would.
    await grace.retrySpaceAccess(room.space);
    expect(await grace.read(["about", "title"], { piece: room })).toBe(
      "Added",
    );
    expect(
      await grace.read(["$VIEWS", "room", "addRequests"], { piece: room }),
    ).toEqual({});
  });

  it("offers a room through a profile whose pointer document holds a copy of the inbox's label beneath its slot", async () => {
    // A link write stores no such copy, but a stored envelope can hold one, as
    // legacy data. Taking the reference to send to the inbox reads no position
    // of the inbox, so the copy joins nothing the add writes.
    const pointer = await grace.link(["profiles", 0, "inbox"]);
    const copy = {
      path: ["piece", "offers"],
      origin: "link",
      label: {
        confidentiality: [cfcAtom.personalSpace(grace.identity.did())],
      },
    };
    const stored = (await grace.rawRead(pointer)).value as unknown as {
      cfc: { labelMap: { entries: unknown[] } };
    };
    await grace.rawWrite(pointer, {
      ...stored,
      cfc: {
        ...stored.cfc,
        labelMap: {
          ...stored.cfc.labelMap,
          entries: [...stored.cfc.labelMap.entries, copy],
        },
      },
    } as unknown as FabricValue);
    await harness.settle();
    expect(
      ((await ada.rawRead(pointer)).value as unknown as typeof stored).cfc
        .labelMap.entries,
    ).toContainEqual(copy);

    await ada.send("createGroup", {
      requestId: "g-copied",
      title: "Copied",
      members: [],
    }, START_ACTION);
    await harness.settle();
    const room = await ada.link(["requests", "g-copied", "entry", "room"]);
    await addByProfile("add-copied", room);
    await harness.settleUntil(() =>
      graceHolds(addMemberOfferId(room.space, "add-copied"))
    );
  });
});
