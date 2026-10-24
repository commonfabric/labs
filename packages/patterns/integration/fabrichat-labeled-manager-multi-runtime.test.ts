/**
 * A FabriChat room whose viewer's manager carries a confidentiality label no
 * room's space admits, as a manager in a person's Home can come to carry
 * their `PersonalSpace` label. Ada's Home stand-in lives in her home space,
 * which her home space's root links, so a room's `#chatManager` wish resolves
 * to her manager, and the manager it reaches carries that label. In a group of
 * hers, in a space of its own, what she sends and whom she adds still land,
 * since nothing the room records reads her manager.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  type PieceAddress,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrichat-labeled-manager",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/** Ada's session, whose DID the fixture's label names. */
const ADA = "fabrichat-labeled-manager-ada";

// The reviewed actions a start, a send, and an add are admitted from, as
// `../fabrichat/schemas.tsx` names them.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };
const SEND_ACTION = { surface: "ChatSendSurface", action: "ChatSend" };
const ADD_MEMBER_ACTION = {
  surface: "ChatAddMemberSurface",
  action: "ChatAddMember",
};

// A stand-in for a principal, a base58btc key as a principal's is.
const BOB = "did:key:z6MkBob";

describe("fabrichat labeled manager across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let ada: MultiRuntimeSession;
  let room: PieceAddress;

  beforeAll(async () => {
    // The stand-in lives in Ada's home space, where a Home does.
    const home =
      (await Identity.fromPassphrase(`multi-runtime-harness ${ADA}`, {
        implementation: "noble",
      })).did();
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [ADA],
      aclMode: "enforce",
      spaceDid: home,
    });
    [ada] = harness.sessions;
    await ada.send("createProfile", { name: "Ada" });
    await harness.settle();
    await ada.client().call("linkHomeRoot", {});
    await harness.settle();
    await ada.send("createGroup", {
      requestId: "g-team",
      title: "Team",
      members: [],
    }, START_ACTION);
    await harness.settle();
    room = await ada.link(["requests", "g-team", "entry", "room"]);
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("records a send and an add in a room whose viewer's manager carries a label the room's space doesn't admit", async () => {
    await ada.send(
      "sendMessage",
      { target: { value: "Hello" } },
      SEND_ACTION,
      { piece: room },
    );
    await harness.settle();
    expect(await ada.read(["messages", "count"], { piece: room })).toBe(1);
    expect(
      await ada.read(["messages", "latest", "messages", 0, "body"], {
        piece: room,
      }),
    ).toBe("Hello");

    await ada.send(
      "addMember",
      { requestId: "add-bob", target: { value: BOB } },
      ADD_MEMBER_ACTION,
      { piece: room },
    );
    // Her manager is still asked how Bob was told, in an event that writes
    // nothing in the room, and with no profile of his to offer the room
    // through, it notices him. Its verdict lands after the add, in the
    // manager's own event, which under server execution the serving loop runs
    // on its own account.
    await harness.settleUntil(async () =>
      (await ada.read(
        ["$VIEWS", "room", "addRequests", "add-bob", "delivery"],
        { piece: room },
      )) !== undefined
    );
    expect(
      await ada.read(["$VIEWS", "room", "addRequests", "add-bob"], {
        piece: room,
      }),
    ).toEqual({ status: "done", delivery: "noticed" });

    // Nothing the room keeps in its space reads her manager either, so the
    // policy gate refused none of the room's own commits on the way: a
    // computed there whose value another pattern takes, and so a document
    // the room's space holds to its policy, would carry her label into the
    // room's space and be refused if it read the manager. A computed only the
    // room's view reads is held to that policy only when the labeled data it
    // reads comes from another space, and here her label reaches the room
    // through the wish's result, which the room's space holds, so this count
    // says nothing of one. `fabrichat-flat-manager-send.test.ts`, whose
    // manager keeps its label in her home space, does.
    const counts = await ada.loggerCounts();
    expect(counts.cfc?.["write-policy-gate"]?.total ?? 0).toBe(0);
  });
});
