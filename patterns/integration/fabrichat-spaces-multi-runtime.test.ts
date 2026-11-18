/**
 * FabriChat's rooms under an enforced access list, across runtimes and under
 * either server-execution posture: a manager creates each room in a space of
 * its own and joins its user to it, and the room's members, and no one else,
 * can read it, unless it is a group made joinable by its link, which anyone
 * can read.
 *
 * Four sessions share the harness's space, where the manager lives: the
 * starter, who creates the rooms; a member of the access-test rooms; a
 * stranger, named in none; and an invited sender with a room of their own.
 * A room's space grants its members at creation, so its member
 * reads it with nothing more to do, and the stranger's read is refused, except
 * of a joinable group's.
 * `fabrichat-manager.test.ts` checks the access list each room's space holds.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import type { FabricValue } from "@commonfabric/data-model";
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
const PROFILE_HOLDER_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrichat-room-profile-wish",
  "main.tsx",
);

/** Returns the CFC write gate's refusal count in one runtime. */
function writeRefusals(
  counts: Record<string, Record<string, { total: number }> | number>,
): number {
  const cfc = counts.cfc;
  return typeof cfc === "object" ? cfc["write-policy-gate"]?.total ?? 0 : 0;
}

// The reviewed action a start is admitted from, as
// `../system/fabrichat/schemas.tsx` names it.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };

// The reviewed action a member is added from, as `../system/fabrichat/schemas.tsx`
// names it.
const ADD_MEMBER_ACTION = {
  surface: "ChatAddMemberSurface",
  action: "ChatAddMember",
};

describe("fabrichat spaces across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let starter: MultiRuntimeSession;
  let member: MultiRuntimeSession;
  let stranger: MultiRuntimeSession;
  let invited: MultiRuntimeSession;

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        "fabrichat-spaces-starter",
        "fabrichat-spaces-member",
        "fabrichat-spaces-stranger",
        "fabrichat-spaces-invited-sender",
      ],
      aclMode: "enforce",
    });
    [starter, member, stranger, invited] = harness.sessions;
    await harness.settle();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  /**
   * Has the starter send `event` on the manager's `stream` from its reviewed
   * start control, checks that the request was done and that the manager
   * joined the starter to the room it produced, and returns that room's
   * address.
   */
  async function start(
    stream: "openDirect" | "createGroup",
    event: Record<string, FabricValue> & { requestId: string },
  ): Promise<PieceAddress> {
    await starter.send(stream, event, START_ACTION);
    await harness.settle();
    expect(await starter.read(["requests", event.requestId, "status"]))
      .toBe("done");
    const room = await starter.link([
      "requests",
      event.requestId,
      "entry",
      "room",
    ]);
    // The room starts with no participants, and holds no messages whose
    // authors it would add, so the one it lists is the starter's join. Under
    // server execution the join is an event the served start emits, which
    // commits in a later wave than the start's own, and `settle()` waits only
    // for the start's; so the wait is for the room to list anyone, and the
    // assertions then say who.
    await harness.settleUntil(async () =>
      (await starter.read(["participants", "length"], { piece: room })) !== 0
    );
    expect(await starter.read(["participants", "length"], { piece: room }))
      .toBe(1);
    expect(await starter.read(["participants", 0, "name"], { piece: room }))
      .toBe("Starter");
    return room;
  }

  it("lets a group room's member read it, and refuses a stranger", async () => {
    const room = await start("createGroup", {
      requestId: "g-1",
      title: "Team",
      members: [member.identity.did()],
    });

    expect(room.space).not.toBe(harness.spaceDid);
    expect(await member.read(["about", "title"], { piece: room }))
      .toBe("Team");
    await expect(stranger.read(["about", "title"], { piece: room })).rejects
      .toThrow(`lacks READ on space ${room.space}`);
  });

  it("reads a group room's message count through the manager's link, and starts a room after it", async () => {
    // The link is part of every manager handler's declared reads, so a room
    // started with one already listed shows that the link reaches nothing a
    // served handler may not read.
    await start("createGroup", {
      requestId: "g-count",
      title: "Counted",
      members: [member.identity.did()],
    });

    expect(
      await starter.read([
        "requests",
        "g-count",
        "entry",
        "room",
        "messages",
        "count",
      ]),
    ).toBe(0);
    // The member, who started nothing, reads the same count through the
    // starter's manager, in either posture.
    expect(
      await member.read([
        "requests",
        "g-count",
        "entry",
        "room",
        "messages",
        "count",
      ]),
    ).toBe(0);
    await start("createGroup", {
      requestId: "g-count-next",
      title: "Counted next",
      members: [member.identity.did()],
    });
    // And raw, through the room the member has read nothing of.
    expect(
      await member.readRaw([
        "requests",
        "g-count-next",
        "entry",
        "room",
        "messages",
        "count",
      ]),
    ).toBe(0);
  });

  it("lets anyone read a group room made joinable by its link", async () => {
    const room = await start("createGroup", {
      requestId: "g-open",
      title: "Open team",
      members: [member.identity.did()],
      joinableByLink: true,
    });

    expect(await stranger.read(["about", "title"], { piece: room }))
      .toBe("Open team");
  });

  it("lets a group room's member add a stranger from the room's add control", async () => {
    const room = await start("createGroup", {
      requestId: "g-add",
      title: "Growing team",
      members: [member.identity.did()],
    });
    const adding = { target: { value: stranger.identity.did() } };

    // Sent as anything but the person's gesture, the add admits no one.
    await member.send("addMember", adding, undefined, { piece: room });
    await harness.settle();
    await expect(stranger.read(["about", "title"], { piece: room })).rejects
      .toThrow(`lacks READ on space ${room.space}`);

    // A member admitted at creation holds OWNER, so their own add, from the
    // room's control, admits the stranger, and the room records it as done
    // where the member's own views read it. No session here has a chat
    // manager to tell the stranger of the room, so the add reads as access
    // alone. The stranger's runtime retains the refusal above; with one
    // connection per space the refused open closed the connection the
    // server's `session/admissible` hint would ride, so it retries the space
    // as its shell's Retry would.
    await member.send(
      "addMember",
      { ...adding, requestId: "add-stranger" },
      ADD_MEMBER_ACTION,
      { piece: room },
    );
    await harness.settle();
    await stranger.retrySpaceAccess(room.space);
    expect(await stranger.read(["about", "title"], { piece: room }))
      .toBe("Growing team");
    expect(
      await member.read(["$VIEWS", "room", "addRequests", "add-stranger"], {
        piece: room,
      }),
    ).toEqual({ status: "done", delivery: "access-only" });
  });

  it("refuses an add to a direct room, even from its counterpart's own control", async () => {
    const room = await start("openDirect", {
      requestId: "d-add",
      counterpart: member.identity.did(),
    });
    const participants = await member.read(["participants", "length"], {
      piece: room,
    });

    // The counterpart holds OWNER, as a member admitted at creation does, and
    // sends from the room's control, yet a direct room keeps its two members.
    // Its views say they can't add, and the refusal carries its code.
    expect(
      await member.read(["$VIEWS", "room", "canAdd"], { piece: room }),
    ).toBe(false);
    await member.send(
      "addMember",
      {
        requestId: "add-to-direct",
        target: { value: stranger.identity.did() },
      },
      ADD_MEMBER_ACTION,
      { piece: room },
    );
    await harness.settle();
    expect(
      await member.read(["$VIEWS", "room", "addRequests", "add-to-direct"], {
        piece: room,
      }),
    ).toEqual({
      status: "refused",
      reason: "A direct chat keeps its two members.",
      code: "direct-room",
    });
    await expect(stranger.read(["about", "kind"], { piece: room })).rejects
      .toThrow(`lacks READ on space ${room.space}`);
    expect(await member.read(["participants", "length"], { piece: room }))
      .toBe(participants);
  });

  it("lets a direct room's counterpart read it, and refuses a stranger", async () => {
    const room = await start("openDirect", {
      requestId: "d-1",
      counterpart: member.identity.did(),
    });

    expect(room.space).not.toBe(harness.spaceDid);
    expect(await member.read(["about", "kind"], { piece: room }))
      .toBe("direct");
    await expect(stranger.read(["about", "kind"], { piece: room })).rejects
      .toThrow(`lacks READ on space ${room.space}`);
  });

  it("lets an invited member send through the manager-created root room", async () => {
    const refusalsBefore = await Promise.all(
      [starter, invited].map(async (session) =>
        writeRefusals(await session.loggerCounts())
      ),
    );
    const room = await start("openDirect", {
      requestId: "d-member-send",
      counterpart: invited.identity.did(),
    });
    // Open the room before selecting a profile. The same session's existing
    // room must pick up that selection when its member sends.
    expect(await invited.read(["about", "kind"], { piece: room })).toBe(
      "direct",
    );
    expect(await invited.read(["messages", "count"], { piece: room })).toBe(0);

    const profile = await invited.createOwnProfile("Invited member");
    await invited.client().call("createPiece", {
      programPath: PROFILE_HOLDER_PATH,
      rootPath: ROOT_PATH,
    });
    await invited.send("holdProfile", { profile });
    await harness.settle();
    await invited.client().call("selectProfile", { path: ["profile"] });
    await harness.settle();
    await harness.settleUntil(async () =>
      (await invited.read(["canSend"], { piece: room })) === true
    );
    expect(await invited.read(["canSend"], { piece: room })).toBe(true);
    await invited.send(
      "sendMessage",
      {
        body: "A message from the invited member",
      },
      { surface: "ChatSendSurface", action: "ChatSend" },
      { piece: room },
    );
    await harness.settle();
    expect(await invited.read(["messages", "count"], { piece: room })).toBe(1);
    expect(
      await starter.read(["messages", "latest", "messages", 0, "body"], {
        piece: room,
      }),
    ).toBe("A message from the invited member");
    expect(
      await invited.link([
        "messages",
        "latest",
        "messages",
        0,
        "authorProfile",
      ], { piece: room }),
    ).toEqual(await invited.link(["profile"]));
    const refusalsAfter = await Promise.all(
      [starter, invited].map(async (session) =>
        writeRefusals(await session.loggerCounts())
      ),
    );
    expect(refusalsAfter).toEqual(refusalsBefore);
  });
});
