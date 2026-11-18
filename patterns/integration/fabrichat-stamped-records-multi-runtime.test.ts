/**
 * FabriChat rooms created by a manager whose own records carry their owner's
 * `PersonalSpace` label, as a Home's manager comes to once an act decided over
 * labeled data records its outcome. The manager's records share one document,
 * as a Home's manager's arguments do. Ada's Home stand-in lives in her home
 * space, and a refused request recorded from her labeled share inbox carries
 * her label. A group naming a member by principal alone, and a direct room
 * with someone named by principal alone, still land, each in a space of its
 * own that admits no such label, and the manager queues a notice for the
 * member it couldn't offer the room to.
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
  "fabrichat-stamped-catalog",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/** Ada's session, whose DID the fixture's label names. */
const ADA = "fabrichat-stamped-catalog-ada";

// The reviewed action a start is admitted from, as
// `../system/fabrichat/schemas.tsx` names it.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };

// A stand-in for another principal, a base58btc key as a principal's is.
const CY = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

describe("fabrichat stamped records across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let ada: MultiRuntimeSession;

  beforeEach(async () => {
    // The stand-in lives in Ada's home space, where a Home does.
    const home =
      (await Identity.fromPassphrase(`multi-runtime-harness ${ADA}`, {
        implementation: "noble",
      })).did();
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [ADA],
      aclMode: "enforce",
      spaceDid: home,
    });
    [ada] = harness.sessions;
    await ada.send("createProfile", { name: "Ada" });
    await ada.send("receive", {
      offer: {
        from: CY,
        id: "offer-1",
        space: "did:key:z6MkSharedSpaceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        host: "https://example.com",
        title: "Labeled",
      },
    });
    await harness.settle();
    await ada.send("recordOffers", {});
    await harness.settle();
    expect(await ada.read(["requests", "offer-1"])).toEqual({
      status: "refused",
      reason: "Labeled",
    });
  });

  afterEach(async () => {
    await harness?.dispose();
  });

  it("creates a group naming a member by principal, and queues a notice for them", async () => {
    await ada.send("createGroup", {
      requestId: "g-team",
      title: "Team",
      members: [CY],
    }, START_ACTION);
    await harness.settle();
    expect(await ada.read(["requests", "g-team", "status"])).toBe("done");

    const room = await ada.link(["requests", "g-team", "entry", "room"]);
    expect(await ada.read(["about", "kind"], { piece: room })).toBe("group");
    expect(await ada.read(["outgoingNotices", 0, "recipient"])).toBe(CY);
  });

  it("creates a direct room with a counterpart named by principal, and records it", async () => {
    await ada.send("openDirect", {
      requestId: "d-cy",
      counterpart: CY,
    }, START_ACTION);
    await harness.settle();
    expect(await ada.read(["requests", "d-cy", "status"])).toBe("done");

    const room = await ada.link(["requests", "d-cy", "entry", "room"]);
    expect(await ada.read(["about", "kind"], { piece: room })).toBe("direct");
    expect(await ada.read(["outgoingNotices", 0, "recipient"])).toBe(CY);
  });
});
