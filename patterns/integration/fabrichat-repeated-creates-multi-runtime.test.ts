/**
 * FabriChat creates one after another, once a Home's shared-space catalog
 * carries its owner's `PersonalSpace` label on an entry's title. Each create
 * queues a `listRooms` event, and that event's handler reads the catalog, so
 * the record of each handled `listRooms` event carries the label too. A later
 * create appends its own `listRooms` event beside those records, and still
 * lands in a space of its own that admits no such label: an append reads the
 * entries already there only to place its own after them.
 *
 * Under server execution, the serving loop writes a handler's sent events,
 * and the marks recording which have been handled, into the stream's entries
 * document within the handler's own transaction; with it off, each session's
 * own runtime runs the handlers, and the same sequences are the control.
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

describe("fabrichat repeated creates across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let ada: MultiRuntimeSession;

  /** Creates a group titled `title` under `requestId`, and returns its status. */
  const createGroup = async (
    requestId: string,
    title: string,
  ): Promise<unknown> => {
    await ada.send(
      "createGroup",
      { requestId, title, members: [] },
      START_ACTION,
    );
    await harness.settle();
    return await ada.read(["requests", requestId, "status"]);
  };

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
    expect(await createGroup("g-old", "Old")).toBe("done");

    // An offer naming the first group's space retitles its entry from Ada's
    // labeled inbox.
    const old = await ada.link(["requests", "g-old", "entry", "room"]);
    await ada.send("receive", {
      offer: {
        from: CY,
        id: "offer-retitle",
        space: old.space,
        host: "https://example.com",
        title: "Old, retitled",
      },
    });
    await harness.settle();
    await ada.send("retitle", {});
    await harness.settle();
    expect(
      await ada.read(["sharedSpaceCatalog", "entries", old.space, "title"]),
    ).toBe("Old, retitled");
  });

  afterEach(async () => {
    await harness?.dispose();
  });

  it("creates groups one after another", async () => {
    expect(await createGroup("g-1", "One")).toBe("done");
    expect(await createGroup("g-2", "Two")).toBe("done");
    expect(await createGroup("g-3", "Three")).toBe("done");
  });

  it("creates groups after a start the manager refuses", async () => {
    expect(await createGroup("g-untitled", "")).toBe("refused");
    expect(await createGroup("g-1", "One")).toBe("done");
    expect(await createGroup("g-2", "Two")).toBe("done");
  });

  it("creates groups after finding a direct room again", async () => {
    await ada.send("openDirect", {
      requestId: "d-first",
      counterpart: CY,
    }, START_ACTION);
    await harness.settle();
    await ada.send("openDirect", {
      requestId: "d-again",
      counterpart: CY,
    }, START_ACTION);
    await harness.settle();
    expect(await ada.read(["requests", "d-again", "status"])).toBe("done");

    expect(await createGroup("g-1", "One")).toBe("done");
    expect(await createGroup("g-2", "Two")).toBe("done");
  });
});
