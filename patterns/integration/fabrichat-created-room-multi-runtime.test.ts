/**
 * The room a FabriChat manager's start reports, against the room its `rooms`
 * lists, across runtimes and under either server-execution posture. A client
 * opens the room a start reports at once, and drops it from its own list once
 * `rooms` names the same room, so the two are compared as the links they are
 * stored as: `equals()` resolves the links it compares, and would find a link
 * to a document holding only a link to the room the same as one to the room.
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
  "fabrichat-spaces",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

// The reviewed action a start is admitted from, as
// `../system/fabrichat/schemas.tsx` names it.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };

// A stand-in for a principal, a base58btc key as a principal's is.
const BOB = "did:key:z6MkBob";

/** Where a stored link points. */
interface Address {
  /** The document's id. */
  id: string;

  /** The document's space. */
  space: string;

  /** The path within the document. */
  path: (string | number)[];
}

/** The address `link`, a stored link as `readRaw()` returns it, points at. */
const addressOf = (link: unknown): Address => {
  const target = (link as { "/": { "link@1": Address } })["/"]["link@1"];
  return { id: target.id, space: target.space, path: target.path };
};

describe("fabrichat created room across runtimes", () => {
  let harness: MultiRuntimeHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  /**
   * Starts the manager's stand-in on a server running with server execution
   * as `serverExecution` says.
   */
  const start = async (
    serverExecution: boolean,
  ): Promise<MultiRuntimeSession> => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [{
        label: "fabrichat-created-room-starter",
        cfc: { experimental: { serverExecution } },
      }],
    });
    const [starter] = harness.sessions;
    await harness.settle();
    return starter;
  };

  /**
   * Has `starter` send `event` on the manager's `stream` from its reviewed
   * start control, waits until `rooms` lists the room the request reports,
   * and returns the address of that room as the outcome stores it.
   */
  const startRoom = async (
    starter: MultiRuntimeSession,
    stream: "openDirect" | "createGroup",
    event: Record<string, string | string[]> & { requestId: string },
  ): Promise<Address> => {
    await starter.send(stream, event, START_ACTION);
    await harness!.settle();
    expect(await starter.read(["requests", event.requestId, "status"]))
      .toBe("done");
    const reported = await starter.link([
      "requests",
      event.requestId,
      "entry",
      "room",
    ]);
    await harness!.settleUntil(async () =>
      (await starter.read([
        "sharedSpaceCatalog",
        "entries",
        reported.space,
        "state",
      ])) === "saved"
    );
    await harness!.settle();
    const entry = await starter.readRaw(["requests", event.requestId, "entry"]);
    return addressOf((entry as { room: unknown }).room);
  };

  /** The addresses of the rooms `rooms` lists, as it stores them. */
  const listedAddresses = async (
    starter: MultiRuntimeSession,
  ): Promise<Address[]> =>
    ((await starter.readRaw(["rooms"])) as { room: unknown }[]).map((entry) =>
      addressOf(entry.room)
    );

  for (const serverExecution of [false, true]) {
    describe(`with server execution ${serverExecution ? "on" : "off"}`, () => {
      it("reports a new group as the room `rooms` lists", async () => {
        const starter = await start(serverExecution);

        const reported = await startRoom(starter, "createGroup", {
          requestId: "g-1",
          title: "Team",
          members: [],
        });
        expect(await listedAddresses(starter)).toEqual([reported]);
      });

      it("reports a new direct room as the room `rooms` lists, with its counterpart", async () => {
        const starter = await start(serverExecution);

        const reported = await startRoom(starter, "openDirect", {
          requestId: "d-1",
          counterpart: BOB,
        });
        expect(await listedAddresses(starter)).toEqual([reported]);
        expect(await starter.read(["rooms", 0, "counterpart"])).toBe(BOB);
        expect(
          addressOf(
            ((await starter.readRaw(["direct", BOB])) as { room: unknown })
              .room,
          ),
        ).toEqual(reported);
      });
    });
  }
});
