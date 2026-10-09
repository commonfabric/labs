/**
 * A Loom creating its own chat room across runtimes, under an enforced access
 * list.
 *
 * Alice owns the Loom's space and Bob is a member. When both ask the Loom for
 * its chat room at once, one room is created and named, both read the same
 * one, and no panel appears at any point. A member who holds only READ is
 * refused, by the access list, wherever `setChatRoom` refuses them.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "..",
  "loom-chat-room-fixture",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/** The gesture the fixture's `lowerToRead` requires. */
const CHANGE_ACCESS = { surface: "MembersSurface", action: "ChangeAccess" };

/** The number of entries `value` holds, or `-1` when it is not a list. */
const count = (value: unknown): number =>
  Array.isArray(value) ? value.length : -1;

/**
 * Whether `stored`, a document as it is stored, is a FabriChat room's: its
 * result carries the room's `sendMessage`, and not the `composerSend` that only
 * the core the room wraps returns.
 */
const isRoom = (stored: unknown): boolean => {
  const value = (stored as { value?: unknown } | undefined)?.value;
  return typeof value === "object" && value !== null &&
    "sendMessage" in value && !("composerSend" in value);
};

/**
 * How many of `session`'s writes the access list has refused: commits its own
 * runtime ran and the server refused, and, under server execution, the event
 * appends the server refused before any handler ran.
 */
async function accessRefusals(session: MultiRuntimeSession): Promise<number> {
  const commits =
    (await session.rejections()).filter((rejection) =>
      rejection.error === "AuthorizationError"
    ).length;
  const appends = (await session.loggerCounts())["event-append-queue"]
    ?.["event-append-refused"]?.total ?? 0;
  return commits + appends;
}

describe("loom chat room across runtimes", () => {
  let harness: MultiRuntimeHarness | undefined;

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
  });

  /** A harness of Alice, who owns the space, and Bob, a member. */
  async function aliceAndBob() {
    const alice = await Identity.fromPassphrase("loom chat room alice", {
      implementation: "noble",
    });
    const bob = await Identity.fromPassphrase("loom chat room bob", {
      implementation: "noble",
    });
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        { label: "alice", identity: alice },
        { label: "bob", identity: bob },
      ],
      aclMode: "enforce",
      recordRejections: true,
    });
    await harness.settle();
    return { harness, alice, bob };
  }

  /** The ids of the FabriChat rooms among the documents `ids` names. */
  async function roomsAmong(
    harness: MultiRuntimeHarness,
    reader: MultiRuntimeSession,
    ids: Iterable<string>,
  ): Promise<string[]> {
    const rooms: string[] = [];
    for (const id of ids) {
      const address = { id, space: harness.spaceDid };
      // Reading the document through a cell is what loads it into the
      // reader's replica; the raw read then returns it as stored. A document
      // that read refuses is left with nothing for the raw read to return, so
      // it is not counted; a room's own document is not refused.
      await reader.client().call("readAddress", {
        link: { ...address, path: [], type: "application/json" },
      }).catch(() => undefined);
      if (isRoom((await reader.rawRead(address)).value)) rooms.push(id);
    }
    return rooms;
  }

  it("names one room, which both sessions read, when two ask at once, and adds no panel", async () => {
    const { harness } = await aliceAndBob();
    const alice = harness.session("alice");
    const bob = harness.session("bob");
    const panelCounts: number[] = [];
    const notePanels = async () => {
      panelCounts.push(
        count(await alice.read(["panels"])),
        count(await bob.read(["panels"])),
        count(await alice.read(["pieceRegistry"])),
        count(await bob.read(["pieceRegistry"])),
      );
    };
    await notePanels();

    const commits = await harness.admittedCommitsDuring(async () => {
      await Promise.all([
        alice.send("ensureChatRoom", {}, undefined, { idle: false }),
        bob.send("ensureChatRoom", {}, undefined, { idle: false }),
      ]);
      for (let round = 0; round < 3; round++) {
        await harness.settle(1);
        await notePanels();
      }
    });
    await harness.settle();
    await notePanels();

    const named = await alice.link(["chatRoom"]);
    expect(named.space).toBe(harness.spaceDid);
    expect(await bob.link(["chatRoom"])).toEqual(named);
    expect(panelCounts).toEqual(panelCounts.map(() => 0));
    expect(panelCounts.length).toBe(20);

    // Of every document written while they raced, the only room is the one
    // named: the run that lost created none that stayed behind.
    const written = new Set(
      commits.filter((commit) => commit.space === harness.spaceDid)
        .flatMap((commit) => commit.writes.map((write) => write.id))
        .filter((id) => id.startsWith("of:")),
    );
    expect(await roomsAmong(harness, alice, written)).toEqual([named.id]);
  });

  it("refuses an ensure, as it refuses a naming, from a member who holds READ", async () => {
    const { harness, bob } = await aliceAndBob();
    const owner = harness.session("alice");
    const reader = harness.session("bob");
    await owner.send("lowerToRead", { principal: bob.did() }, CHANGE_ACCESS);
    await harness.settle();
    const room = await owner.createCell("loom chat room named", {
      $NAME: "Named room",
    });

    const before = await accessRefusals(reader);
    await reader.send("setChatRoom", { room });
    await harness.settle();
    const afterNaming = await accessRefusals(reader);
    await reader.send("ensureChatRoom", {});
    await harness.settle();
    const afterEnsure = await accessRefusals(reader);

    expect(afterNaming).toBeGreaterThan(before);
    expect(afterEnsure).toBeGreaterThan(afterNaming);
    expect(await owner.read(["chatRoom"])).toBeUndefined();
    expect(await reader.read(["chatRoom"])).toBeUndefined();
    expect(count(await owner.read(["panels"]))).toBe(0);

    // The owner's own ensure, from the same state, names a room.
    await owner.send("ensureChatRoom", {});
    await harness.settle();
    expect((await owner.link(["chatRoom"])).space).toBe(harness.spaceDid);
    expect(count(await owner.read(["panels"]))).toBe(0);
  });
});
