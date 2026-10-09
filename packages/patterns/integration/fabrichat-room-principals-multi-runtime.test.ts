/**
 * A FabriChat room's participants' principals across runtimes whose
 * principals may read different things. A profile lives in its owner's own
 * space, and a reader that space refuses can't read whom the profile attests,
 * so two members of a room derive the list differently. Two sessions share the
 * harness's space, where the manager lives: the starter, who creates a group
 * room, and a member, named in it, who joins it under a profile in a space
 * that admits the member alone. Each session reads the list from an instance
 * of its own, and once every runtime has caught up, none of them commits
 * anything more.
 *
 * Kept apart from `fabrichat-spaces-multi-runtime.test.ts`, whose test
 * selection record names that file's whole `describe()`, so that a lane
 * selecting this case runs it.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  resolveServerExecution,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrichat-spaces",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

// Where a client that draws natively reads the participants' principals.
const PRINCIPALS = ["$VIEWS", "room", "participantPrincipals"];

/** Whether this run's harness serves handlers from a serving loop. */
const SERVER_EXECUTION = resolveServerExecution();

// The reviewed action a start is admitted from, as
// `../fabrichat/schemas.tsx` names it.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };

describe("fabrichat room principals across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let starter: MultiRuntimeSession;
  let member: MultiRuntimeSession;

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        "fabrichat-principals-starter",
        "fabrichat-principals-member",
      ],
      aclMode: "enforce",
    });
    [starter, member] = harness.sessions;
    await harness.settle();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("gives each session the principals it can read, and commits nothing more once every runtime has caught up", async () => {
    await starter.send("createGroup", {
      requestId: "g-principals",
      title: "Team",
      members: [member.identity.did()],
    }, START_ACTION);
    await harness.settle();
    expect(await starter.read(["requests", "g-principals", "status"]))
      .toBe("done");
    const room = await starter.link([
      "requests",
      "g-principals",
      "entry",
      "room",
    ]);
    // Under server execution the starter's join is an event the served start
    // emits, which commits in a later wave than the start's own, so the wait
    // is for the room to list anyone.
    await harness.settleUntil(async () =>
      (await starter.read(["participants", "length"], { piece: room })) !== 0
    );

    // The member joins under a profile only they can read. The starter's
    // profile, the fixture's stand-in, attests no one, so the member reads
    // their own principal alone. The starter's own runtime, which the
    // profile's space refuses, reads none; a serving loop derives the list
    // for them, and reads the member's.
    const profile = await member.createOwnProfile("Member");
    await member.send("addParticipant", { profile }, undefined, {
      piece: room,
    });
    await harness.settle();
    expect(await member.read(["participants", "length"], { piece: room }))
      .toBe(2);
    expect(await member.read(PRINCIPALS, { piece: room }))
      .toEqual([member.identity.did()]);
    expect(await starter.read(PRINCIPALS, { piece: room }))
      .toEqual(SERVER_EXECUTION ? [member.identity.did()] : []);

    // Each session reads an instance of its own: one instance for every
    // reader is a document the readers' runtimes hold differently.
    expect(await starter.link(PRINCIPALS, { piece: room }))
      .toMatchObject({ scope: "session" });

    // A whole settle of every runtime and the server, with nothing left to
    // happen, admits no commit. Each document written is named with the
    // instance it was written in, so a failure says what is still being written.
    const admitted = await harness.admittedCommitsDuring(() =>
      harness.settle()
    );
    expect(
      admitted.map((notice) =>
        notice.writes.map((write) => `${write.id} in ${write.scopeKey}`)
      ),
    ).toEqual([]);
  });
});
