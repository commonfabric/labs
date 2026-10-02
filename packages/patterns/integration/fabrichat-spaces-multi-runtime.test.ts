/**
 * FabriChat's rooms under an enforced access list, across runtimes and under
 * either server-execution posture: a manager creates each room in a space of
 * its own, and the room's members, and no one else, can read it, unless it is
 * a group made joinable by its link, which anyone can read.
 *
 * Three sessions share the harness's space, where the manager lives: the
 * starter, who creates the rooms; a member, named in each; and a stranger,
 * named in none. A room's space grants its members at creation, so the member
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
import { FabricEpochNsec } from "@commonfabric/data-model/fabric-primitives";
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

describe("fabrichat spaces across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let starter: MultiRuntimeSession;
  let member: MultiRuntimeSession;
  let stranger: MultiRuntimeSession;

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        "fabrichat-spaces-starter",
        "fabrichat-spaces-member",
        "fabrichat-spaces-stranger",
      ],
      aclMode: "enforce",
    });
    [starter, member, stranger] = harness.sessions;
    await harness.settle();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  /**
   * Has the starter send `event` on the manager's `stream`, checks that the
   * request was done, and returns the address of the room it produced.
   */
  async function start(
    stream: "openDirect" | "createGroup",
    event: Record<string, FabricValue> & { requestId: string },
  ): Promise<PieceAddress> {
    await starter.send(stream, event, {
      surface: "ChatStartSurface",
      action: "ChatStart",
    });
    await harness.settle();
    expect(await starter.read(["requests", event.requestId, "status"]))
      .toBe("done");
    return await starter.link(["requests", event.requestId, "entry", "room"]);
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
    expect(await member.read(["about", "record", "kind"], { piece: room }))
      .toBe("group");
    expect(
      await member.read(["about", "policy", "keepsHistory"], { piece: room }),
    )
      .toBe(true);
    await expect(stranger.read(["about", "title"], { piece: room })).rejects
      .toThrow(`lacks READ on space ${room.space}`);
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
    expect(await stranger.read(["about", "record", "kind"], { piece: room }))
      .toBe("group");
  });

  it("lets a direct room's counterpart read it, and refuses a stranger", async () => {
    const room = await start("openDirect", {
      requestId: "d-1",
      counterpart: member.identity.did(),
    });

    expect(room.space).not.toBe(harness.spaceDid);
    expect(await member.read(["about", "kind"], { piece: room }))
      .toBe("direct");
    expect(await member.read(["about", "record", "kind"], { piece: room }))
      .toBe("direct");
    await expect(stranger.read(["about", "kind"], { piece: room })).rejects
      .toThrow(`lacks READ on space ${room.space}`);
  });

  it("accepts an omitted request ID and member list on the public group stream", async () => {
    await starter.send("createGroup", { title: "Solo conversation" }, {
      surface: "ChatStartSurface",
      action: "ChatStart",
    });
    await harness.settle();
    const room = await starter.link(["rooms", 0, "room"]);
    expect(await starter.read(["about", "title"], { piece: room }))
      .toBe("Solo conversation");
    expect(await starter.read(["about", "record", "kind"], { piece: room }))
      .toBe("group");
  });

  it("records a refusal when an accept request omits its room", async () => {
    await starter.send("accept", { requestId: "missing-room" });
    await harness.settle();
    expect(await starter.read(["requests", "missing-room", "status"]))
      .toBe("refused");
    expect(await starter.read(["requests", "missing-room", "reason"]))
      .toBe("Choose a conversation to add.");
  });

  it("updates the creator's initially empty room after its counterpart sends first", async () => {
    for (const session of [starter, member]) {
      const surface = await session.link([
        "profileWish",
        "$UI",
        "props",
        "$cell",
      ]);
      await session.send(
        "createProfile",
        {
          target: { value: session.label },
        },
        { surface: "ProfileCreateSurface", action: "CreateProfile" },
        {
          piece: surface,
        },
      );
      await harness.settle();
      expect(await session.read(["profileWish", "result", "name"]))
        .toBe(session.label);
    }
    const room = await start("createGroup", {
      requestId: "remote-first",
      title: "Remote first message",
      members: [member.identity.did()],
    });
    expect(await starter.read(["messages", "count"], { piece: room })).toBe(0);
    expect(
      await starter.client().call("viewText", {
        path: ["requests", "remote-first", "entry", "room", "$UI"],
      }),
    ).toContain("Start the conversation.");
    expect(await member.read(["canSend"], { piece: room })).toBe(true);
    const body = "The invited member speaks first";
    await member.send(
      "sendMessage",
      {
        requestId: "remote-first-message",
        version: {
          body,
          sentAt: new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
        },
      },
      { surface: "ChatSendSurface", action: "ChatSend" },
      { piece: room },
    );
    await harness.settle();
    const author = await member.link([
      "messages",
      "latest",
      "messages",
      0,
      "authorProfile",
    ], { piece: room });
    const selectedProfile = await member.link(["profileWish", "result"]);
    expect(author).toEqual(selectedProfile);
    expect(await starter.read(["name"], { piece: author })).toBe(member.label);
    expect(await member.read(["messages", "count"], { piece: room })).toBe(1);
    expect(await starter.read(["messages", "count"], { piece: room })).toBe(1);
    expect(
      await starter.read(["messages", "latest", "messages", 0, "body"], {
        piece: room,
      }),
    ).toBe(body);
    expect(
      await starter.client().call("viewText", {
        path: ["requests", "remote-first", "entry", "room", "$UI"],
      }),
    ).toContain(body);
  });
});
