/**
 * The FabriChat manager's `rooms` over a shared-space catalog that also holds
 * an entry for a space this replica can't serve, as a catalog comes to hold
 * one for a space on another host, or for one not yet created. The manager
 * looks for a room behind every saved entry; a space it can't serve leaves
 * that entry's room unfound, and the groups the person creates are still
 * listed. A saved entry for a served space that holds no room, and a catalog
 * with no other entry, are the controls.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrichat-rooms-unservable-entry",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

// The reviewed action a start is admitted from, as `../fabrichat/schemas.tsx`
// names it.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };

// A space no one serves here, as one on another host is.
const UNSERVED_SPACE = "did:key:z6MkSharedSpaceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// How a client that demands the fields as a plain array reads `rooms`.
const ROOMS_DEMAND = {
  type: "array",
  items: { type: "object", properties: { kind: { type: "string" } } },
} as const;

describe("fabrichat rooms beside an unservable catalog entry across runtimes", () => {
  let harness: MultiRuntimeHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  /**
   * Starts the stand-in on a server running with server execution as
   * `serverExecution` says, gives the person a profile, and registers
   * `entry`'s space in their catalog, where there is one.
   */
  const start = async (
    serverExecution: boolean,
    entry: ((ada: MultiRuntimeSession) => Promise<string>) | undefined,
  ): Promise<MultiRuntimeSession> => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [{
        label: "fabrichat-rooms-unservable-entry-ada",
        cfc: { experimental: { serverExecution } },
      }],
    });
    const [ada] = harness.sessions;
    await ada.send("createProfile", { name: "Ada" });
    await harness.settle();
    if (entry !== undefined) {
      await ada.send("register", {
        space: await entry(ada),
        host: "https://example.com",
        kind: "workspace",
      });
      await harness.settle();
    }
    return ada;
  };

  /** Creates a group, and waits until the catalog lists it. */
  const createGroup = async (ada: MultiRuntimeSession, requestId: string) => {
    await ada.send("createGroup", {
      requestId,
      title: requestId,
      members: [],
    }, START_ACTION);
    await harness!.settle();
    expect(await ada.read(["requests", requestId, "status"])).toBe("done");
    const room = await ada.link(["requests", requestId, "entry", "room"]);
    await harness!.settleUntil(async () =>
      (await ada.read([
        "sharedSpaceCatalog",
        "entries",
        room.space,
        "state",
      ])) === "saved"
    );
    await harness!.settle();
  };

  /** The kinds `rooms` lists, as a client demanding a plain array reads it. */
  const listedKinds = async (ada: MultiRuntimeSession) =>
    ((await ada.readAs(["rooms"], ROOMS_DEMAND)) as
      | { kind?: string }[]
      | undefined)?.map((entry) => entry.kind);

  for (const serverExecution of [false, true]) {
    describe(`with server execution ${serverExecution ? "on" : "off"}`, () => {
      it("lists each new group when the catalog holds no other entry", async () => {
        const ada = await start(serverExecution, undefined);
        expect(await listedKinds(ada)).toEqual([]);

        await createGroup(ada, "g-first");
        expect(await listedKinds(ada)).toEqual(["group"]);
        await createGroup(ada, "g-second");
        expect(await listedKinds(ada)).toEqual(["group", "group"]);
      });

      it("lists each new group beside a saved entry for a space this replica can't serve", async () => {
        const ada = await start(
          serverExecution,
          () => Promise.resolve(UNSERVED_SPACE),
        );
        expect(await listedKinds(ada)).toEqual([]);

        await createGroup(ada, "g-first");
        expect(await listedKinds(ada)).toEqual(["group"]);
        await createGroup(ada, "g-second");
        expect(await listedKinds(ada)).toEqual(["group", "group"]);
      });

      it("lists each new group beside a saved entry for a served space that holds no room", async () => {
        // The person's profile has a space of its own, served here, whose root
        // is a profile and not a room.
        const ada = await start(
          serverExecution,
          async (session) => (await session.link(["profiles", 0])).space,
        );
        expect(await listedKinds(ada)).toEqual([]);

        await createGroup(ada, "g-first");
        expect(await listedKinds(ada)).toEqual(["group"]);
        await createGroup(ada, "g-second");
        expect(await listedKinds(ada)).toEqual(["group", "group"]);
      });
    });
  }
});
