/**
 * The multi-runtime harness driving the system private inbox: its owner
 * creates it and has their profiles point at it, a sender's own handler
 * delivers offers through the owner's profile, and a stranger tries to read
 * them.
 *
 * Under server execution the inbox's space is its owner's alone, since the
 * serving loop makes the sender's write; without it, the sender's own runtime
 * makes the write, so the space grants every principal `WRITE`, and every
 * principal can read it.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { aclDocId } from "@commonfabric/memory/acl";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  type PieceAddress,
  resolveServerExecution,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "private-inbox",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/** Whether this run's harness serves handlers from a serving loop. */
const SERVER_EXECUTION = resolveServerExecution();

/** The CFC write gate's refusals, out of one runtime's logger counts. */
const writeRefusals = (
  counts: Record<string, Record<string, { total: number }> | number>,
): number => {
  const cfc = counts.cfc;
  return typeof cfc === "object" ? cfc["write-policy-gate"]?.total ?? 0 : 0;
};

/** An offer as the owner reads it. */
type ReadOffer = { kind: string; space: string; title?: string; from: string };

describe("private inbox across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let owner: MultiRuntimeSession;
  let sender: MultiRuntimeSession;
  let stranger: MultiRuntimeSession;
  let inbox: PieceAddress;

  /** The link a profile of the owner's holds to its inbox, if any. */
  const profileInbox = async (index: number) =>
    await owner.link(["profiles", index, "inbox", "piece"]);

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        "private-inbox-owner",
        "private-inbox-sender",
        "private-inbox-stranger",
      ],
      aclMode: "enforce",
    });
    [owner, sender, stranger] = harness.sessions;

    // Two profiles, the second already pointing at an inbox of its own.
    await owner.send("createProfile");
    await owner.send("createProfile");
    await owner.send("createOtherInbox");
    await harness.settle();
    await owner.send("pointSecondProfileElsewhere");
    await harness.settleUntil(async () =>
      (await owner.read(["profiles", 1, "inbox", "piece"])) !== undefined
    );

    await owner.send("ensurePrivateInbox");
    await harness.settleUntil(async () =>
      (await owner.read(["profiles", 0, "inbox", "piece"])) !== undefined
    );
    inbox = await owner.link(["privateInbox", "piece"]);
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  /** The offers the owner reads in the inbox. */
  const ownerOffers = async (): Promise<ReadOffer[]> =>
    (await owner.read(["offers"], { piece: inbox })) as ReadOffer[];

  /**
   * How many commits the CFC write gate has refused, in the sender's runtime
   * and in this process, where the serving loop runs. The gate counts each
   * refusal whatever the log level shows.
   */
  const refusals = async (): Promise<number> =>
    writeRefusals(await sender.loggerCounts()) +
    writeRefusals(getLoggerCountsBreakdown());

  /**
   * Whether the memory server refuses the sender's runtime the inbox's space.
   * Without server execution the sender's runtime runs the inbox's `receive`
   * itself, which it cannot do in a space it may not read: the event waits
   * for a load that is refused, and nothing commits that a delivery wait could
   * see. With server execution the space's server runs it, so the sender's
   * own access does not decide delivery, and this is `false`.
   */
  const senderRefusedInbox = async (): Promise<boolean> =>
    !SERVER_EXECUTION &&
    await sender.read(["offers"], { piece: inbox }).then(
      () => false,
      () => true,
    );

  /**
   * Has the sender's own handler send an offer through the owner's first
   * profile, and waits for the owner to read it or for the append to be
   * refused, then asserts the first. The append is a consequence of a
   * consequence, which a `settle()` does not wait for.
   */
  const offer = async (title: string): Promise<void> => {
    const refusedBefore = await refusals();
    await sender.send("offer", { space: harness.spaceDid, title });
    await harness.settleUntil(async () =>
      (await ownerOffers()).some((each) => each.title === title) ||
      await refusals() > refusedBefore || await senderRefusedInbox()
    );
    expect(await senderRefusedInbox()).toBe(false);
    expect(await refusals()).toBe(refusedBefore);
    expect((await ownerOffers()).map((each) => each.title)).toContain(title);
  };

  it("creates the inbox in a space of its own, with the access the setting calls for", async () => {
    expect(inbox.space).not.toBe(harness.spaceDid);
    const address = {
      id: aclDocId(inbox.space as `did:${string}:${string}`),
      space: inbox.space,
    };
    // Reading the document through a cell is what loads it into the owner's
    // replica; the raw read then returns it as stored.
    await owner.client().call("readAddress", {
      link: { ...address, path: [], type: "application/json" },
    });
    const acl = (await owner.rawRead(address)).value as { value?: unknown };

    expect(acl.value).toEqual({
      [owner.identity.did()]: "OWNER",
      ...(SERVER_EXECUTION ? {} : { "*": "WRITE" }),
    });
  });

  it("points the profile with no inbox at it, and leaves the other as it was", async () => {
    const other = await owner.link(["otherInbox", "piece"]);

    expect((await profileInbox(0)).id).toBe(inbox.id);
    expect((await profileInbox(1)).id).toBe(other.id);
    expect(other.id).not.toBe(inbox.id);
  });

  it("creates and re-points nothing when ensured again", async () => {
    await owner.send("ensurePrivateInbox");
    await harness.settle();

    expect(await owner.link(["privateInbox", "piece"])).toEqual(inbox);
    expect((await profileInbox(0)).id).toBe(inbox.id);
  });

  it("delivers each offer a sender's own handler sends, stamped with the sender", async () => {
    const before = (await ownerOffers()).length;

    for (const title of ["first", "second", "third"]) await offer(title);

    const offers = await ownerOffers();
    expect(offers.slice(before).map((each) => each.title)).toEqual([
      "first",
      "second",
      "third",
    ]);
    for (const each of offers.slice(before)) {
      expect(each.kind).toBe("fabrichat-room");
      expect(each.space).toBe(harness.spaceDid);
      expect(each.from).toBe(sender.identity.did());
    }
  });

  it("refuses a stranger's read of the inbox", {
    ignore: !SERVER_EXECUTION,
  }, async () => {
    await offer("unread");

    await expect(stranger.read(["offers"], { piece: inbox })).rejects
      .toThrow();
  });

  it("refuses a stranger's served copy of the offers", {
    ignore: !SERVER_EXECUTION,
  }, async () => {
    await offer("private");

    const refusedBefore = writeRefusals(getLoggerCountsBreakdown());
    await stranger.send("copyOffers");
    await harness.settle();
    expect(writeRefusals(getLoggerCountsBreakdown())).toBeGreaterThan(
      refusedBefore,
    );
    expect(await stranger.read(["copiedOffers"])).toEqual([]);
  });
});
