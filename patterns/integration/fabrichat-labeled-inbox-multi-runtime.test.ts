/**
 * FabriChat offers to a person whose profile's inbox pointer carries their
 * `PersonalSpace` label, as a pointer can come to carry its inbox's label. Ada's
 * Home stand-in lives in her home space, which admits no such label. Grace has
 * a stand-in of her own, with a private inbox in a space of its own and a
 * profile pointing at it through that labeled pointer. Ada's manager offers
 * Grace a group she is added to, and a direct room it finds again with a notice
 * for her still waiting: each offer reaches Grace's inbox, and each request's
 * outcome lands in Ada's records.
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
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrichat-labeled-inbox",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/** Ada's session, whose home space the harness's space is. */
const ADA = "fabrichat-labeled-inbox-ada";

/** Grace's session, whose DID the fixture's label names. */
const GRACE = "fabrichat-labeled-inbox-grace";

// The reviewed action a start is admitted from, as
// `../system/fabrichat/schemas.tsx` names it.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };

/** The address of a cell, as `MultiRuntimeSession.link()` returns one. */
type CellAddress = Awaited<ReturnType<MultiRuntimeSession["link"]>>;

/** A link to `address`, as an event carries one. */
const linkTo = (address: CellAddress) => ({
  "/": {
    "link@1": { id: address.id, path: address.path, space: address.space },
  },
});

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
    await harness.settle();
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
  });

  afterEach(async () => {
    await harness?.dispose();
  });

  it("offers a group to a member added to it, and records the verdict", async () => {
    await ada.send("createGroup", {
      requestId: "g-team",
      title: "Team",
      members: [],
    }, START_ACTION);
    await harness.settle();
    const group = await ada.link(["requests", "g-team", "entry", "room"]);

    await ada.send("offerRoom", {
      requestId: "add-grace",
      room: linkTo(group),
      profile: linkTo(graceProfile),
    });
    await harness.settle();
    expect(await ada.read(["requests", "add-grace"])).toEqual({
      status: "done",
      delivery: "offered",
    });
    await harness.settleUntil(() => graceHolds("add-grace"));
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

    // A start naming her profile finds the room, and offers it there.
    await ada.send("openDirect", {
      requestId: "d-again",
      counterpart: grace.identity.did(),
      profile: linkTo(graceProfile),
    }, START_ACTION);
    await harness.settle();
    expect(await ada.read(["requests", "d-again", "status"])).toBe("done");
    await harness.settleUntil(() => graceHolds("d-again"));
    expect(await ada.read(["outgoingNotices", "length"])).toBe(0);
  });
});
