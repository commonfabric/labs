/**
 * The FabriChat manager across runtimes whose principals may read different
 * things: once a room is created and every runtime has caught up with it, none
 * of them commits anything more. Four sessions share the harness's space,
 * where the manager lives: the starter, who creates a group room, and a second
 * session of the starter's, as a second tab is; a member, named in it; and a
 * stranger, named in none, whose reads of the room's space are refused. A
 * value the manager derives from what the room's space holds, stored once for
 * every reader, is one the stranger's runtime computes differently from the
 * others', and the runtimes then overwrite each other's value without end. Read
 * access is the principal's, so the manager stores such a value once per user,
 * which both of the starter's sessions share.
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
import { Identity } from "@commonfabric/identity";
import { scopeOfScopeKey } from "@commonfabric/memory/v2";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  type PieceAddress,
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

// Where a client that draws natively reads the user's rooms.
const ROOMS = ["$VIEWS", "chats", "rooms"];

// How a client that demands the fields as plain arrays, with no scope, asks
// for them.
const ROOMS_DEMAND = {
  type: "array",
  items: { type: "object", properties: { kind: { type: "string" } } },
} as const satisfies JSONSchema;

describe("fabrichat manager across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let starter: MultiRuntimeSession;
  let member: MultiRuntimeSession;
  let stranger: MultiRuntimeSession;
  let starterTab: MultiRuntimeSession;

  beforeAll(async () => {
    const starterIdentity = await Identity.fromPassphrase(
      "fabrichat-quiet-starter",
      { implementation: "noble" },
    );
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        { label: "fabrichat-quiet-starter", identity: starterIdentity },
        "fabrichat-quiet-member",
        "fabrichat-quiet-stranger",
        { label: "fabrichat-quiet-starter-tab", identity: starterIdentity },
      ],
      aclMode: "enforce",
    });
    [starter, member, stranger, starterTab] = harness.sessions;
    await harness.settle();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("commits nothing more once every runtime has caught up with a room a stranger can't read", async () => {
    let room!: PieceAddress;
    const created = await harness.admittedCommitsDuring(async () => {
      await starter.send("createGroup", {
        requestId: "g-quiet",
        title: "Team",
        members: [member.identity.did()],
      }, START_ACTION);
      await harness.settle();
      expect(await starter.read(["requests", "g-quiet", "status"]))
        .toBe("done");
      room = await starter.link(["requests", "g-quiet", "entry", "room"]);
      // Under server execution the starter's join is an event the served
      // start emits, which commits in a later wave than the start's own, so
      // the wait is for the room to list anyone.
      await harness.settleUntil(async () =>
        (await starter.read(["participants", "length"], { piece: room })) !== 0
      );
    });
    expect(await member.read(["about", "title"], { piece: room }))
      .toBe("Team");
    await expect(stranger.read(["about", "title"], { piece: room })).rejects
      .toThrow(`lacks READ on space ${room.space}`);

    // Each reader's `rooms` lists the room only where its space admits them,
    // and a client that demands them as a plain array reads each reader's own.
    const demanded = async (session: MultiRuntimeSession) =>
      ((await session.readAs(ROOMS, ROOMS_DEMAND)) as { kind?: string }[])
        .map((entry) => entry.kind);
    expect(await demanded(starter)).toEqual(["group"]);
    expect(await demanded(starterTab)).toEqual(["group"]);
    expect(await demanded(member)).toEqual(["group"]);
    expect(await demanded(stranger)).toEqual([]);

    // `rooms` is stored per user, which the starter's two sessions share, and
    // the create wrote it in no instance of a session's own.
    const rooms = await starter.link(ROOMS);
    expect(rooms).toMatchObject({ scope: "user" });
    expect(await starterTab.link(ROOMS)).toEqual(rooms);
    const roomsWrittenIn = new Set(
      created.flatMap((notice) => notice.writes)
        .filter((write) => write.id === rooms.id)
        .map((write) => scopeOfScopeKey(write.scopeKey)),
    );
    expect(roomsWrittenIn).toEqual(new Set(["user"]));

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
