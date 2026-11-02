/**
 * FabriChat offers to a person whose profile's inbox pointer carries their
 * `PersonalSpace` label, as a pointer can come to carry its inbox's label. Ada's
 * Home stand-in lives in her home space, which admits no such label, and which
 * her home space's root links, so that a room's `#chatManager` wish resolves to
 * her manager. Grace has a stand-in of her own, with a private inbox in a space
 * of its own and a profile pointing at it through that labeled pointer. Ada
 * adds Grace to a group from the room, finds a direct room with her again with
 * a notice for her still waiting, and creates a group naming her profile. Each
 * request's outcome lands in Ada's records, and, with handlers run by each
 * session's own runtime, each offer reaches Grace's inbox and lists her on the
 * room's roster.
 *
 * Both stand-ins share the harness's one space, Ada's home, so the server runs
 * with no access list: a home space grants no one but its owner.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
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

/** Ada's session, whose home space the harness's space is. */
const ADA = "fabrichat-labeled-inbox-ada";

/** Grace's session, whose DID the fixture's label names. */
const GRACE = "fabrichat-labeled-inbox-grace";

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

/** The CFC write gate's refusals, out of one runtime's logger counts. */
const writeRefusals = (
  counts: Record<string, Record<string, { total: number }> | number>,
): number => {
  const cfc = counts.cfc;
  return typeof cfc === "object" ? cfc["write-policy-gate"]?.total ?? 0 : 0;
};

describe("fabrichat labeled inbox pointer across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let ada: MultiRuntimeSession;
  let grace: MultiRuntimeSession;
  let graceProfile: CellAddress;
  let graceInbox: CellAddress;

  /** Whether Grace's inbox holds an offer whose id is `id`. */
  const graceHolds = async (id: string): Promise<boolean> =>
    ((await grace.read(["offers"], { piece: graceInbox })) as
      | { id: string }[]
      | undefined ?? []).some((offer) => offer.id === id);

  /** Whether the roster of `room` lists Grace's profile. */
  const rosterListsGrace = async (room: CellAddress): Promise<boolean> => {
    const length = (await ada.read(["roster", "length"], { piece: room })) as
      | number
      | undefined ?? 0;
    for (let index = 0; index < length; index++) {
      const known = await ada.link(["roster", index], { piece: room });
      if (known.id === graceProfile.id && known.space === graceProfile.space) {
        return true;
      }
    }
    return false;
  };

  /**
   * How many commits the CFC write gate has refused, in Ada's runtime and
   * where the serving loop runs. The gate counts each refusal whatever the log
   * level shows.
   */
  const refusals = async (): Promise<number> =>
    writeRefusals(await ada.loggerCounts()) +
    writeRefusals((await harness.servingDiagnostics()).loggerCounts);

  /**
   * Waits for the offer `id` of `room` to reach Grace's inbox and list her on
   * the room's roster, or for a commit to be refused since `refusedBefore`,
   * and asserts the first. The offer is a consequence of the event that
   * decided it, which a `settle()` does not wait for; the serving loop seals
   * a refusal as the event's consequence, a commit that wakes the wait.
   */
  const expectOffered = async (
    room: CellAddress,
    id: string,
    refusedBefore: number,
  ): Promise<void> => {
    await harness.settleUntil(async () =>
      (await graceHolds(id) && await rosterListsGrace(room)) ||
      await refusals() > refusedBefore
    );
    if (SERVER_EXECUTION) {
      // TODO(danfuzz): Expect the offer to arrive under server execution too.
      // The served `offerRooms` reads Grace's labeled pointer, so its sends
      // and its mark that it handled its event, which live in Ada's home
      // space, are refused, and nothing reaches Grace. That holds until a
      // served handler reading another person's labeled data can commit them.
      expect(await refusals()).toBeGreaterThan(refusedBefore);
      expect(await graceHolds(id)).toBe(false);
      return;
    }
    expect(await refusals()).toBe(refusedBefore);
    expect(await graceHolds(id)).toBe(true);
    expect(await rosterListsGrace(room)).toBe(true);
  };

  beforeEach(async () => {
    // Ada's stand-in lives in her home space, where a Home does.
    const home =
      (await Identity.fromPassphrase(`multi-runtime-harness ${ADA}`, {
        implementation: "noble",
      })).did();
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [ADA, GRACE],
      spaceDid: home,
    });
    [ada, grace] = harness.sessions;

    // Grace's stand-in is a piece of her own, which becomes her session's.
    await grace.client().call("createPiece", {
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
    });
    await grace.send("createLabeledProfile", {});
    await grace.send("createInbox", {});
    await harness.settle();
    await grace.send("pointInbox", {});
    await harness.settleUntil(async () =>
      (await grace.read(["profiles", 0, "inbox", "piece"])) !== undefined
    );
    graceProfile = await grace.link(["profiles", 0]);
    graceInbox = await grace.link(["privateInbox", "piece"]);

    await ada.send("createProfile", { name: "Ada" });
    await harness.settle();
    await ada.client().call("linkHomeRoot", {});
    await harness.settle();
  });

  afterEach(async () => {
    await harness?.dispose();
  });

  it("tells a member added to a group of it, through their profile's inbox", async () => {
    await ada.send("createGroup", {
      requestId: "g-team",
      title: "Team",
      members: [],
    }, START_ACTION);
    await harness.settle();
    const group = await ada.link(["requests", "g-team", "entry", "room"]);

    const refusedBefore = await refusals();
    await ada.send(
      "addMember",
      { requestId: "add-grace", profile: linkTo(graceProfile) },
      ADD_MEMBER_ACTION,
      { piece: group },
    );
    await harness.settleUntil(async () =>
      (await ada.read(
        ["$VIEWS", "room", "addRequests", "add-grace", "delivery"],
        { piece: group },
      )) !== undefined
    );
    expect(
      await ada.read(["$VIEWS", "room", "addRequests", "add-grace"], {
        piece: group,
      }),
    ).toEqual({ status: "done", delivery: "offered" });
    await expectOffered(
      group,
      addMemberOfferId(group.space, "add-grace"),
      refusedBefore,
    );
  });

  it("offers a direct room found again to its counterpart, and withdraws their notice", async () => {
    // A start naming Grace by principal alone creates the room and queues a
    // notice for her, since it has no profile to offer the room through.
    await ada.send("openDirect", {
      requestId: "d-first",
      counterpart: grace.identity.did(),
    }, START_ACTION);
    await harness.settle();
    expect(await ada.read(["requests", "d-first", "status"])).toBe("done");
    await harness.settleUntil(async () =>
      (await ada.read(["outgoingNotices", "length"])) === 1
    );
    const direct = await ada.link(["requests", "d-first", "entry", "room"]);

    // A start naming her profile finds the room, and offers it there.
    const refusedBefore = await refusals();
    await ada.send("openDirect", {
      requestId: "d-again",
      counterpart: grace.identity.did(),
      profile: linkTo(graceProfile),
    }, START_ACTION);
    await harness.settle();
    expect(await ada.read(["requests", "d-again", "status"])).toBe("done");
    expect(await ada.read(["outgoingNotices", "length"])).toBe(0);
    await expectOffered(direct, "d-again", refusedBefore);
  });

  it("offers a group created naming the member's profile", async () => {
    const refusedBefore = await refusals();
    await ada.send("createGroup", {
      requestId: "g-named",
      title: "Named",
      members: [],
      profiles: [linkTo(graceProfile)],
    }, START_ACTION);
    await harness.settle();
    expect(await ada.read(["requests", "g-named", "status"])).toBe("done");
    const group = await ada.link(["requests", "g-named", "entry", "room"]);
    await expectOffered(group, "g-named", refusedBefore);
  });
});
