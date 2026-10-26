/**
 * FabriChat rooms created over a shared-space catalog that carries its
 * owner's `PersonalSpace` label, as a Home's catalog comes to once it takes in
 * an offer carrying that label. Ada's Home stand-in lives in her home space,
 * and her share inbox's offers carry her label. Once her catalog has taken
 * one, a group or a direct room she creates still lands, in a space of its own
 * that admits no such label, and her catalog lists it.
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

// The reviewed action a start is admitted from, as `../fabrichat/schemas.tsx`
// names it.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };

// A stand-in for another principal, a base58btc key as a principal's is.
const CY = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

// A space offered to Ada through her inbox.
const OFFERED_SPACE = "did:key:z6MkSharedSpaceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("fabrichat stamped catalog across runtimes", () => {
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
        space: OFFERED_SPACE,
        host: "https://example.com",
      },
    });
    await harness.settle();
    await ada.send("ingest", {});
    await harness.settle();
    expect(
      await ada.read(["sharedSpaceCatalog", "entries", OFFERED_SPACE, "kind"]),
    ).toBe("workspace");
  });

  afterEach(async () => {
    await harness?.dispose();
  });

  it("creates a group, and lists it in the catalog", async () => {
    await ada.send("createGroup", {
      requestId: "g-team",
      title: "Team",
      members: [],
    }, START_ACTION);
    await harness.settle();
    expect(await ada.read(["requests", "g-team", "status"])).toBe("done");

    const room = await ada.link(["requests", "g-team", "entry", "room"]);
    expect(await ada.read(["about", "kind"], { piece: room })).toBe("group");
    expect(
      await ada.read(["sharedSpaceCatalog", "entries", room.space]),
    ).toMatchObject({
      space: room.space,
      kind: "fabrichat-room",
      state: "saved",
      title: "Team",
    });
  });

  it("creates a direct room, and lists it in the catalog", async () => {
    await ada.send("openDirect", {
      requestId: "d-cy",
      counterpart: CY,
    }, START_ACTION);
    await harness.settle();
    expect(await ada.read(["requests", "d-cy", "status"])).toBe("done");

    const room = await ada.link(["requests", "d-cy", "entry", "room"]);
    expect(await ada.read(["about", "kind"], { piece: room })).toBe("direct");
    expect(
      await ada.read(["sharedSpaceCatalog", "entries", room.space]),
    ).toMatchObject({
      space: room.space,
      kind: "fabrichat-room",
      state: "saved",
    });
  });
});
