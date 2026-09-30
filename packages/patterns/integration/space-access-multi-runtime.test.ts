/**
 * The multi-runtime harness under an enforced access list, driving a piece
 * that lives in a space of its own.
 *
 * A manager piece in the harness's space creates each room in a new space,
 * which only the room's creator may reach. The guest session is granted the
 * harness's space and nothing else, so reading a room is a read of a space it
 * was never granted until the room's owner grants it. Both runs of this file,
 * one per server-execution posture, host the storage server in `enforce`
 * mode; with the harness's default of `off`, the guest would read every room
 * from the start.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  type PieceAddress,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "space-access-multi-runtime",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/** The gesture a room's `grant` stream requires, as a members surface gives. */
const CHANGE_ACCESS = { surface: "MembersSurface", action: "ChangeAccess" };

describe("space access across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let owner: MultiRuntimeSession;
  let guest: MultiRuntimeSession;

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: ["space-access-owner", "space-access-guest"],
      aclMode: "enforce",
    });
    [owner, guest] = harness.sessions;
    await harness.settle();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  /**
   * Has the owner create a room titled `title`, and returns the address of
   * the room's piece, which lives in the room's own space.
   */
  async function createRoom(title: string): Promise<PieceAddress> {
    await owner.send("create", { title });
    await harness.settle();
    const rooms = await owner.read(["rooms"]) as { title: string }[];
    const index = rooms.findIndex((room) => room.title === title);
    expect(index).not.toBe(-1);
    return await owner.link(["rooms", index]);
  }

  it("refuses a non-member's read of a room in its own space", async () => {
    const room = await createRoom("Refused");

    expect(room.space).not.toBe(harness.spaceDid);
    expect(await owner.read(["title"], { piece: room })).toBe("Refused");
    await expect(guest.read(["title"], { piece: room })).rejects.toThrow(
      `lacks READ on space ${room.space}`,
    );
  });

  it("reads a room for a member its owner granted", async () => {
    const room = await createRoom("Granted");
    await expect(guest.read(["title"], { piece: room })).rejects.toThrow(
      `lacks READ on space ${room.space}`,
    );

    await owner.send(
      "grant",
      { principal: guest.identity.did() },
      CHANGE_ACCESS,
      { piece: room },
    );
    await harness.settle();

    if (harness.serverExecution) {
      // A served handler cannot change an access list: `grantSpaceAccess()`
      // throws on a serving runtime, and the throw drops the handler's own
      // write along with it.
      // TODO(danfuzz): Hold this posture to the other one's outcome once a
      // served handler can change an access list.
      expect(await owner.read(["members"], { piece: room })).toEqual([]);
      return;
    }
    expect(await owner.read(["members"], { piece: room })).toEqual([
      guest.identity.did(),
    ]);
    expect(await guest.read(["title"], { piece: room })).toBe("Granted");
    expect(await guest.read(["members"], { piece: room })).toEqual([
      guest.identity.did(),
    ]);
  });
});
