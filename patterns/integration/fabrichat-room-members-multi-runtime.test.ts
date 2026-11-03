/**
 * A FabriChat room's members across runtimes whose principals may read
 * different things: each principal the room's space's access list names, with
 * the roster's profiles that are their own. A profile lives in its owner's own
 * space, and a reader that space refuses can't read whose own the profile is,
 * so two members of a room derive the members' profiles differently. Two
 * sessions share the harness's space, where the manager lives: the starter,
 * who creates a group room, and a member, named in it, who joins it under a
 * profile in a space that admits the member alone. Each user reads the
 * members from an instance of their own, and the room's deprecated
 * `participantPrincipals` and `participantEntries` as the same members in the
 * shapes clients read before, and once every runtime has caught up, none of
 * them commits anything more.
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
import type { JSONSchema } from "@commonfabric/api";
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

// Where a client that draws natively reads the room's members.
const MEMBERS = ["$VIEWS", "room", "members"];

// Where a client that draws natively reads the deprecated principals, and the
// entries pairing each member's profile with their principal.
const PRINCIPALS = ["$VIEWS", "room", "participantPrincipals"];
const ENTRIES = ["$VIEWS", "room", "participantEntries"];

// How a client that demands the members as a plain array, with no scope, asks
// for them.
const MEMBERS_DEMAND = {
  type: "array",
  items: { type: "object", properties: { principal: { type: "string" } } },
} as const satisfies JSONSchema;

/** Whether this run's harness serves handlers from a serving loop. */
const SERVER_EXECUTION = resolveServerExecution();

// The reviewed action a start is admitted from, as
// `../system/fabrichat/schemas.tsx` names it.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };

describe("fabrichat room members across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let starter: MultiRuntimeSession;
  let member: MultiRuntimeSession;

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        "fabrichat-members-starter",
        "fabrichat-members-member",
      ],
      aclMode: "enforce",
    });
    [starter, member] = harness.sessions;
    await harness.settle();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("gives each session the members it can read, with the profiles it can read as theirs, and commits nothing more once every runtime has caught up", async () => {
    await starter.send("createGroup", {
      requestId: "g-members",
      title: "Team",
      members: [member.identity.did()],
    }, START_ACTION);
    await harness.settle();
    expect(await starter.read(["requests", "g-members", "status"]))
      .toBe("done");
    const room = await starter.link([
      "requests",
      "g-members",
      "entry",
      "room",
    ]);
    // Under server execution the starter's join is an event the served start
    // emits, which commits in a later wave than the start's own, so the wait
    // is for the room to list anyone.
    await harness.settleUntil(async () =>
      (await starter.read(["participants", "length"], { piece: room })) !== 0
    );

    // The member joins under a profile only they can read.
    const profile = await member.createOwnProfile("Member");
    await member.send("addParticipant", { profile }, undefined, {
      piece: room,
    });
    await harness.settle();
    expect(await member.read(["participants", "length"], { piece: room }))
      .toBe(2);

    // Both readers read both members, the room's two OWNERs, in DID order,
    // whatever they can read of the profiles.
    const order = [starter.identity.did(), member.identity.did()].sort();
    const index = order.indexOf(member.identity.did());
    for (const session of [starter, member]) {
      expect(await session.read([...MEMBERS, "length"], { piece: room }))
        .toBe(2);
      for (const [at, did] of order.entries()) {
        expect(
          await session.read([...MEMBERS, at, "principal"], { piece: room }),
        ).toBe(did);
        expect(await session.read([...MEMBERS, at, "level"], { piece: room }))
          .toBe("OWNER");
      }
    }

    // The starter's profile, the fixture's stand-in, is no one's, so the
    // starter has none. The member reads their own profile as theirs, the
    // one the room lists second. The starter's own runtime, which the
    // profile's space refuses, reads it as no one's; a serving loop derives
    // the members for them, and reads it as the member's.
    const profilesOf = (session: MultiRuntimeSession, at: number) =>
      session.read([...MEMBERS, at, "profiles", "length"], { piece: room });
    expect(await profilesOf(member, 1 - index)).toBe(0);
    expect(await profilesOf(starter, 1 - index)).toBe(0);
    expect(await profilesOf(member, index)).toBe(1);
    expect(
      await member.link([...MEMBERS, index, "profiles", 0], {
        piece: room,
      }),
    ).toEqual(await member.link(["participants", 1], { piece: room }));
    expect(await profilesOf(starter, index)).toBe(SERVER_EXECUTION ? 1 : 0);

    // A client that demands the members as a plain array reads them all the
    // same.
    for (const session of [starter, member]) {
      expect(
        ((await session.readAs(MEMBERS, MEMBERS_DEMAND, { piece: room })) as {
          principal?: string;
        }[]).map((entry) => entry.principal ?? "none"),
      ).toEqual(order);
    }

    // The deprecated principals are the members', for every reader, and the
    // entries the member profiles the reader reads as theirs.
    for (const session of [starter, member]) {
      expect(await session.read(PRINCIPALS, { piece: room })).toEqual(order);
    }
    expect(await member.read([...ENTRIES, "length"], { piece: room }))
      .toBe(1);
    expect(await member.read([...ENTRIES, 0, "principal"], { piece: room }))
      .toBe(member.identity.did());
    expect(await member.link([...ENTRIES, 0, "profile"], { piece: room }))
      .toEqual(await member.link(["participants", 1], { piece: room }));
    expect(await starter.read([...ENTRIES, "length"], { piece: room }))
      .toBe(SERVER_EXECUTION ? 1 : 0);

    // Each user reads an instance of their own: one instance for every
    // reader is a document the readers' runtimes hold differently, and
    // access is the principal's, so every session of one user shares theirs.
    for (const path of [MEMBERS, PRINCIPALS, ENTRIES]) {
      expect(await starter.link(path, { piece: room }))
        .toMatchObject({ scope: "user" });
    }

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
