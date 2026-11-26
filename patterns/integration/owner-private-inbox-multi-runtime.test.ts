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
 * offers into a piece of its own lands labeled for the owner, and reaches the
 * stranger all the same, which is a known gap (Topics top/3173).
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  type PieceAddress,
  resolveServerExecution,
} from "./multi-runtime-harness.ts";
import {
  afterAll,
  beforeAll,
  describe,
  it,
} from "@commonfabric/test-support/test";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "owner-private-inbox",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/** Whether this run's harness serves handlers from a serving loop. */
const SERVER_EXECUTION = resolveServerExecution();

/**
 * The count of messages the CFC logger keyed `key`, out of one runtime's
 * logger counts.
 */
const cfcCount = (
  counts: Record<string, Record<string, { total: number }> | number>,
  key: string,
): number => {
  const cfc = counts.cfc;
  return typeof cfc === "object" ? cfc[key]?.total ?? 0 : 0;
};

/** The CFC write gate's refusals, out of one runtime's logger counts. */
const writeRefusals = (
  counts: Record<string, Record<string, { total: number }> | number>,
): number => cfcCount(counts, "write-policy-gate");

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
   * and where the serving loop runs. The gate counts each
   * refusal whatever the log level shows.
   */
  const refusals = async (): Promise<number> =>
    writeRefusals(await sender.loggerCounts()) +
    writeRefusals((await harness.servingDiagnostics()).loggerCounts);

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

  it(
    "lands a stranger's served copy of the offers labeled for the owner, and delivers it to the stranger",
    {
      ignore: !SERVER_EXECUTION,
    },
    async () => {
      // A served run is measured as any run is, so the copy commits, and each
      // copied offer carries the owner's `User` clause, as a commitment to the
      // owner's DID since the clause crossed a space boundary (§4.6.4.1). The
      // stranger cannot read the inbox, and reads the copy: the memory server
      // delivers a document to every reader of its space, whatever its label
      // admits. That delivery is a known gap (Topics top/3173), and the last
      // expectation flips when delivery checks the label.

      await offer("private");
      const notes = await ownerNotes();
      await expect(stranger.read(["offers"], { piece: inbox })).rejects
        .toThrow("lacks READ");

      const refusedBefore = await refusals();
      await stranger.send("copyOffers");
      const copiedNotes = async (from: MultiRuntimeSession) =>
        ((await from.read(["copiedOffers"])) as { note: string }[])
          .map((item) => item.note);
      await harness.settleUntil(async () =>
        (await copiedNotes(owner)).length === notes.length ||
        await refusals() > refusedBefore
      );
      expect(await refusals()).toBe(refusedBefore);
      expect(await copiedNotes(owner)).toEqual(notes);

      const container = await stranger.link(["copiedOffers"]);
      const raw = await stranger.rawRead({
        id: container.id,
        space: container.space,
      });
      const rows = (raw.value as {
        value: { copiedOffers: { "/": { "link@1": { id: string } } }[] };
      }).value.copiedOffers;
      expect(rows).toHaveLength(notes.length);
      for (const row of rows) {
        const entries = await stranger.storedLabelEntries({
          id: row["/"]["link@1"].id,
          space: container.space,
        });
        expect(
          entries.filter((entry) => entry.origin === "declared"),
        ).toMatchObject([{
          path: [],
          label: {
            confidentiality: [{
              type: "https://commonfabric.org/cfc/atom/User",
              subject: { digestOf: expect.any(String) },
            }],
          },
        }]);
      }

      expect(await copiedNotes(stranger)).toEqual(notes);
    },
  );
});
