/**
 * The multi-runtime harness driving an owner-private inbox: a list labeled for
 * the principal who created it, each item labeled for that principal too,
 * which another principal appends to from a handler of their own.
 *
 * The owner creates the inbox in a space of its own. Under server execution
 * that space is the owner's alone, since the serving loop makes the sender's
 * write; without it, the sender's own runtime makes the write, so the space
 * grants every principal `WRITE`. Each item the sender appends becomes a
 * document of its own, created in the sender's transaction, and is bound to
 * the inbox's owner rather than to the sender. A stranger's served copy of the
 * offers into a piece of its own is refused.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
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
  "owner-private-inbox",
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

describe("owner-private inbox across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let owner: MultiRuntimeSession;
  let sender: MultiRuntimeSession;
  let stranger: MultiRuntimeSession;
  let inbox: PieceAddress;

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        "owner-private-inbox-owner",
        "owner-private-inbox-sender",
        "owner-private-inbox-stranger",
      ],
      aclMode: "enforce",
    });
    [owner, sender, stranger] = harness.sessions;
    await owner.send("create", { open: !SERVER_EXECUTION });
    await harness.settle();
    inbox = await owner.link(["inboxes", 0]);
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  /** The notes of the offers the owner reads in the inbox. */
  const ownerNotes = async (): Promise<string[]> =>
    ((await owner.read(["offers"], { piece: inbox })) as { note: string }[])
      .map((offer) => offer.note);

  /**
   * How many commits the CFC write gate has refused, in the sender's runtime
   * and in this process, where the serving loop runs. The gate counts each
   * refusal whatever the log level shows.
   */
  const refusals = async (): Promise<number> =>
    writeRefusals(await sender.loggerCounts()) +
    writeRefusals(getLoggerCountsBreakdown());

  /**
   * Has the sender's own handler send an offer, and waits for the owner to
   * read it or for the append to be refused, then asserts the first. The
   * sender's handler sends on to the inbox's own, so the append is a
   * consequence of a consequence, which a `settle()` does not wait for. The
   * sender's own runtime refuses before the wait begins; the serving loop
   * seals its refusal as the event's consequence, a commit that wakes it.
   */
  const offer = async (note: string): Promise<void> => {
    const refusedBefore = await refusals();
    await sender.send("offer", { note });
    await harness.settleUntil(async () =>
      (await ownerNotes()).includes(note) ||
      await refusals() > refusedBefore
    );
    expect(await refusals()).toBe(refusedBefore);
    expect(await ownerNotes()).toContain(note);
  };

  it("delivers each offer a sender's own handler appends", async () => {
    expect(inbox.space).not.toBe(harness.spaceDid);
    const before = await ownerNotes();

    for (const note of ["first", "second", "third"]) await offer(note);

    expect(await ownerNotes()).toEqual([
      ...before,
      "first",
      "second",
      "third",
    ]);
  });

  it("refuses a stranger's served copy of the offers", {
    ignore: !SERVER_EXECUTION,
  }, async () => {
    // Copying the inbox's public title shows the stranger's handler runs and
    // commits; copying the offers is refused, so what the stranger's piece
    // holds stays as it was.

    await offer("private");

    await stranger.send("copyTitle");
    await harness.settle();
    expect(await stranger.read(["copiedTitle"])).toBe("Offers");

    const refusedBefore = writeRefusals(getLoggerCountsBreakdown());
    await stranger.send("copyOffers");
    await harness.settle();
    expect(writeRefusals(getLoggerCountsBreakdown())).toBeGreaterThan(
      refusedBefore,
    );
    expect(await stranger.read(["copiedOffers"])).toEqual([]);
  });
});
