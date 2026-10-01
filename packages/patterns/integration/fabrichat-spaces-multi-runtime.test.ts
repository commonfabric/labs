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
    await starter.send(stream, event);
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
});
