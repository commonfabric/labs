/**
 * The FabriChat manager across sessions of its one user, as in a home space,
 * and under either server-execution posture: a session that starts once the
 * manager lists its rooms reads them as stored, and what it writes in its own
 * scope there does not grow with the number of rooms. The person has a Home
 * stand-in, which holds their profile and their manager, and every session is
 * theirs.
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
  "fabrichat-add-offer",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

// The reviewed action a start is admitted from, as
// `../fabrichat/schemas.tsx` names it.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };

// Where a client that draws natively reads the user's rooms.
const ROOMS = ["chatManager", "$VIEWS", "chats", "rooms"];

describe("fabrichat manager across sessions", () => {
  let harness: MultiRuntimeHarness;
  let first: MultiRuntimeSession;

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: ["fabrichat-sessions-first"],
      aclMode: "enforce",
    });
    [first] = harness.sessions;
    // A manager starts no chat for a person with no profile.
    await first.send("createProfile", { name: "Ada" });
    await harness.settle();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  /** Has the first session create a group of the person's alone. */
  async function createGroup(requestId: string): Promise<void> {
    await first.send(
      "createGroup",
      { requestId, title: requestId, members: [] },
      START_ACTION,
    );
    await harness.settleUntil(async () =>
      (await first.read(["requests", requestId, "status"])) === "done"
    );
  }

  /**
   * Starts another session of the person's, waits for it to list `rooms`
   * rooms, and returns each document of the manager's space a session wrote
   * in its own scope while it did, once. A room's space, where a session a
   * serving loop starts the room for keeps the room's own per-session state,
   * is left out.
   */
  async function sessionScopedWritesOfNewSession(
    label: string,
    rooms: number,
  ): Promise<string[]> {
    const admitted = await harness.admittedCommitsDuring(async () => {
      const session = await harness.addSession({
        label,
        identity: first.identity,
      });
      await harness.settleUntil(async () =>
        (await session.read([...ROOMS, "length"])) === rooms
      );
      await harness.settle();
    });
    return [
      ...new Set(
        admitted.filter((notice) => notice.space === harness.spaceDid)
          .flatMap((notice) => notice.writes)
          .filter((write) => write.scopeKey.startsWith("session:"))
          .map((write) => `${write.id} in ${write.scopeKey}`),
      ),
    ];
  }

  it("writes as many documents in a later session's scope whether the manager lists one room or three", async () => {
    await createGroup("g-1");
    await harness.settleUntil(async () =>
      (await first.read([...ROOMS, "length"])) === 1
    );
    const withOneRoom = await sessionScopedWritesOfNewSession(
      "fabrichat-sessions-second",
      1,
    );

    await createGroup("g-2");
    await createGroup("g-3");
    await harness.settleUntil(async () =>
      (await first.read([...ROOMS, "length"])) === 3
    );
    const withThreeRooms = await sessionScopedWritesOfNewSession(
      "fabrichat-sessions-third",
      3,
    );

    expect(withThreeRooms.length).toBe(withOneRoom.length);
  });
});
