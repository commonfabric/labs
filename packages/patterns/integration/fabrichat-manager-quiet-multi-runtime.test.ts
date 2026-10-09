/**
 * The FabriChat manager across runtimes whose principals may read different
 * things: once a room is created and every runtime has caught up with it, none
 * of them commits anything more. Three sessions share the harness's space,
 * where the manager lives: the starter, who creates a group room; a member,
 * named in it; and a stranger, named in none, whose reads of the room's space
 * are refused. A value the manager derives from what the room's space holds,
 * stored once for every reader, is one the stranger's runtime computes
 * differently from the others', and the runtimes then overwrite each other's
 * value without end.
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
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrichat-spaces",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

// The reviewed action a start is admitted from, as
// `../fabrichat/schemas.tsx` names it.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };

describe("fabrichat manager across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let starter: MultiRuntimeSession;
  let member: MultiRuntimeSession;
  let stranger: MultiRuntimeSession;

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        "fabrichat-quiet-starter",
        "fabrichat-quiet-member",
        "fabrichat-quiet-stranger",
      ],
      aclMode: "enforce",
    });
    [starter, member, stranger] = harness.sessions;
    await harness.settle();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("commits nothing more once every runtime has caught up with a room a stranger can't read", async () => {
    await starter.send("createGroup", {
      requestId: "g-quiet",
      title: "Team",
      members: [member.identity.did()],
    }, START_ACTION);
    await harness.settle();
    expect(await starter.read(["requests", "g-quiet", "status"]))
      .toBe("done");
    const room = await starter.link([
      "requests",
      "g-quiet",
      "entry",
      "room",
    ]);
    // Under server execution the starter's join is an event the served start
    // emits, which commits in a later wave than the start's own, so the wait
    // is for the room to list anyone.
    await harness.settleUntil(async () =>
      (await starter.read(["participants", "length"], { piece: room })) !== 0
    );
    expect(await member.read(["about", "title"], { piece: room }))
      .toBe("Team");
    await expect(stranger.read(["about", "title"], { piece: room })).rejects
      .toThrow(`lacks READ on space ${room.space}`);

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
