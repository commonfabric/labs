/**
 * FabriChat manager acts over a shared-space catalog one of whose entries has
 * a title carrying its owner's `PersonalSpace` label, as a Home's catalog
 * comes to once an entry is retitled from labeled data. Ada's Home stand-in
 * lives in her home space, and her share inbox's offers carry her label; an
 * offer naming her group's space, with a title, retitles the group's entry.
 * Grace has a stand-in of her own, with a profile pointing at her private
 * inbox, in a space of its own. Ada's manager then offers Grace the group,
 * finds a direct room with her again and offers it to her, and joins the
 * group, each in an act that reads the whole catalog beside data from another
 * space and sends an event.
 *
 * With handlers run by each session's own runtime, every act lands, and each
 * offer reaches Grace's inbox, a space that admits no such label. Under server
 * execution, each act is refused: see `expectRefusedUnderServerExecution()`.
 *
 * Both stand-ins share the harness's one space, Ada's home, so the server
 * runs with no access list: a home space grants no one but its owner.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  resolveServerExecution,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrichat-stamped-catalog",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/** Whether this run's harness serves handlers from a serving loop. */
const SERVER_EXECUTION = resolveServerExecution();

/** Ada's session, whose DID the fixture's label names. */
const ADA = "fabrichat-stamped-catalog-ada";

/** Grace's session. */
const GRACE = "fabrichat-stamped-catalog-grace";

// The reviewed action a start is admitted from, as `../fabrichat/schemas.tsx`
// names it.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };

/** The address of a cell, as `MultiRuntimeSession.link()` returns one. */
type CellAddress = Awaited<ReturnType<MultiRuntimeSession["link"]>>;

/** A link to `address`, as an event carries one. */
const linkTo = (address: CellAddress) => ({
  "/": {
    "link@1": { id: address.id, path: address.path, space: address.space },
  },
});

/**
 * The refusals the CFC write gate has logged in this process, where the
 * harness's serving loop runs under server execution.
 */
const writeRefusals = (): number => {
  const cfc = getLoggerCountsBreakdown().cfc;
  return typeof cfc === "object" ? cfc["write-policy-gate"]?.total ?? 0 : 0;
};

describe("fabrichat stamped title offers across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let ada: MultiRuntimeSession;
  let grace: MultiRuntimeSession;
  let group: CellAddress;
  let graceProfile: CellAddress;
  let graceInbox: CellAddress;

  /** Whether Grace's inbox holds an offer whose id is `id`. */
  const graceHolds = async (id: string): Promise<boolean> =>
    ((await grace.read(["offers"], { piece: graceInbox })) as
      | { id: string }[]
      | undefined ?? []).some((offer) => offer.id === id);

  /**
   * Asserts that the request `requestId`, sent once the write gate had logged
   * `refusedBefore` refusals, was refused by the gate and recorded nothing.
   */
  const expectRefusedUnderServerExecution = async (
    requestId: string,
    refusedBefore: number,
  ): Promise<void> => {
    // TODO(danfuzz): This is the wrong outcome, pinned as what happens
    // today. The served act's join holds the stamped title, from Ada's home,
    // beside clauses from other spaces, the room's among them, so the
    // stream-entries documents it writes in Ada's home lose their exemption
    // from writer-fit and are measured against `Space(<her home>)`, which her
    // own `PersonalSpace` label doesn't fit. Expect the act to land, as the other
    // posture does, once the CFC specification rules on whether such a
    // document admits its space owner's label and the runtime follows
    // (`isDeclarablePolicyStore()` in `packages/runner/src/cfc/prepare.ts`).
    expect(writeRefusals()).toBeGreaterThan(refusedBefore);
    expect(await ada.read(["requests", requestId])).toBeUndefined();
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
    await grace.send("createProfile", { name: "Grace" });
    await harness.settle();
    await grace.client().call("ensurePrivateInbox", { path: [] });
    await harness.settleUntil(async () =>
      (await grace.read(["profiles", 0, "inbox", "piece"])) !== undefined
    );
    graceProfile = await grace.link(["profiles", 0]);
    graceInbox = await grace.link(["privateInbox", "piece"]);

    await ada.send("createProfile", { name: "Ada" });
    await harness.settle();
    await ada.send("createGroup", {
      requestId: "g-team",
      title: "Team",
      members: [],
    }, START_ACTION);
    await harness.settle();
    group = await ada.link(["requests", "g-team", "entry", "room"]);

    // An offer naming the group's space retitles its entry from Ada's
    // labeled inbox.
    await ada.send("receive", {
      offer: {
        from: grace.identity.did(),
        id: "offer-retitle",
        space: group.space,
        host: "https://example.com",
        title: "Team, retitled",
      },
    });
    await harness.settle();
    await ada.send("retitle", {});
    await harness.settle();
    expect(
      await ada.read(["sharedSpaceCatalog", "entries", group.space, "title"]),
    ).toBe("Team, retitled");
  });

  afterEach(async () => {
    await harness?.dispose();
  });

  it("offers a group to a member added to it, through their profile's inbox", async () => {
    const refusedBefore = writeRefusals();
    await ada.send("offerRoom", {
      requestId: "add-grace",
      room: linkTo(group),
      profile: linkTo(graceProfile),
    });
    await harness.settle();
    if (SERVER_EXECUTION) {
      await expectRefusedUnderServerExecution("add-grace", refusedBefore);
      return;
    }
    expect(await ada.read(["requests", "add-grace"])).toEqual({
      status: "done",
      delivery: "offered",
    });
    await harness.settleUntil(() => graceHolds("add-grace"));
  });

  it("offers a direct room found again to its counterpart, through their profile's inbox", async () => {
    // A start naming Grace by principal alone creates the room and queues a
    // notice for her, since it has no profile to offer the room through.
    await ada.send("openDirect", {
      requestId: "d-first",
      counterpart: grace.identity.did(),
    }, START_ACTION);
    await harness.settle();
    expect(await ada.read(["requests", "d-first", "status"])).toBe("done");
    expect(await ada.read(["outgoingNotices", "length"])).toBe(1);

    // A start naming her profile finds the room, and offers it there.
    const refusedBefore = writeRefusals();
    await ada.send("openDirect", {
      requestId: "d-again",
      counterpart: grace.identity.did(),
      profile: linkTo(graceProfile),
    }, START_ACTION);
    await harness.settle();
    if (SERVER_EXECUTION) {
      await expectRefusedUnderServerExecution("d-again", refusedBefore);
      return;
    }
    expect(await ada.read(["requests", "d-again", "status"])).toBe("done");
    expect(await ada.read(["outgoingNotices", "length"])).toBe(0);
    await harness.settleUntil(() => graceHolds("d-again"));
  });

  it("joins a group the catalog lists, under a request", async () => {
    const refusedBefore = writeRefusals();
    await ada.send("joinRoom", { requestId: "j-team", room: linkTo(group) });
    await harness.settle();
    if (SERVER_EXECUTION) {
      await expectRefusedUnderServerExecution("j-team", refusedBefore);
      return;
    }
    expect(await ada.read(["requests", "j-team", "status"])).toBe("done");
    expect(await ada.read(["requests", "j-team", "entry", "kind"])).toBe(
      "group",
    );
  });
});
