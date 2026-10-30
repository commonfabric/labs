/**
 * FabriChat starts by a person whose own profile's inbox pointer carries their
 * `PersonalSpace` label, as a pointer can come to carry its inbox's label.
 * Ada's Home stand-in lives in her home space, and her manager's profile lives
 * in a space of its own. A start reads only as much of her profile as tells
 * it she has one, so a group with no other members, and a direct room with
 * someone named by principal, each land in a space of its own that admits no
 * such label.
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
  "fabrichat-labeled-own-profile",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/** Ada's session, whose DID the fixture's label names. */
const ADA = "fabrichat-labeled-own-profile-ada";

// The reviewed action a start is admitted from, as
// `../system/fabrichat/schemas.tsx` names it.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };

// A stand-in for another principal, a base58btc key as a principal's is.
const CY = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

describe("fabrichat labeled own profile across runtimes", () => {
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
    await harness.settle();
    expect(await ada.read(["profiles", 0, "name"])).toBe("Ada");
  });

  afterEach(async () => {
    await harness?.dispose();
  });

  it("creates a group with no other members", async () => {
    await ada.send("createGroup", {
      requestId: "g-team",
      title: "Team",
      members: [],
    }, START_ACTION);
    await harness.settle();
    expect(await ada.read(["requests", "g-team", "status"])).toBe("done");

    const room = await ada.link(["requests", "g-team", "entry", "room"]);
    expect(await ada.read(["about", "kind"], { piece: room })).toBe("group");
  });

  it("creates a direct room with someone named by principal", async () => {
    await ada.send("openDirect", {
      requestId: "d-cy",
      counterpart: CY,
    }, START_ACTION);
    await harness.settle();
    expect(await ada.read(["requests", "d-cy", "status"])).toBe("done");

    const room = await ada.link(["requests", "d-cy", "entry", "room"]);
    expect(await ada.read(["about", "kind"], { piece: room })).toBe("direct");
  });
});
