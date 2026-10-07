/**
 * The multi-runtime harness driving the system private inbox: its owner
 * creates it and has their profiles point at it, current and earlier vintages
 * alike, a sender's own handler delivers offers to the inbox the owner's
 * profile points at, and a stranger tries to read them. Two more Homes, whose
 * profiles already point at inboxes, are given their inboxes by the host: one
 * adopts an inbox shaped as a loom daemon's rather than creating one, and the
 * other is refused another principal's inbox, and holds none. A fourth Home
 * creates its inbox, and once its only profile is pointed at an inbox shaped
 * as a loom daemon's, as when the daemon writes the pointer last, adopts that
 * one and retains the one it held, whose offers stay readable.
 *
 * The inbox's space grants every principal `WRITE` in both server-execution
 * postures: the serving loop makes a sender's write where server execution is
 * on, and the sender's own runtime makes it where it is not.
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

/** What the host found when it ensured a Home's inbox. */
type HostEnsure = {
  outcome: string;
  reason?: string;
  inbox?: { id: string; space: string };
};

/** An offer as the owner reads it. */
type ReadOffer = {
  kind: string;
  id: string;
  space: string;
  host: string;
  ownerOrigin: string;
  title: string;
  from: string;
  sharedAt: number;
  receivedAt: number;
};

describe("private inbox across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let owner: MultiRuntimeSession;
  let sender: MultiRuntimeSession;
  let stranger: MultiRuntimeSession;
  let inbox: PieceAddress;
  let adopted: PieceAddress;
  let created: HostEnsure;
  let adoption: HostEnsure;
  let refusal: HostEnsure;
  let refusalsBefore: number;
  let readoptCreated: HostEnsure;
  let readoption: HostEnsure;
  let readoptOriginal: PieceAddress;

  /** The link a profile of the owner's holds to its inbox, if any. */
  const profileInbox = async (index: number) =>
    await owner.link(["profiles", index, "inbox", "piece"]);

  /** The link a profile of `adoptingHome`'s holds to its inbox, if any. */
  const adoptingProfileInbox = async (index: number) =>
    await owner.link(["adoptingHome", "profiles", index, "inbox", "piece"]);

  /**
   * Has the owner's host ensure the inbox of the Home stand-in at `path`, as
   * it ensures the identity's own Home's.
   */
  const ensureThroughHost = async (path: string[]): Promise<HostEnsure> =>
    await owner.client().call("ensurePrivateInbox", { path }) as HostEnsure;

  /** How many adoption refusals the owner's host has logged. */
  const adoptionRefusals = async (): Promise<number> => {
    const counts = (await owner.loggerCounts())["piece.private-inbox"];
    return typeof counts === "object"
      ? counts["adoption-refused"]?.total ?? 0
      : 0;
  };

  /** Whether the stored value at `path` holds an inbox link. */
  const pointed = async (path: (string | number)[]): Promise<boolean> =>
    (await owner.read([...path, "inbox", "piece"])) !== undefined;

  /** The ACL of the space `piece` is in, as stored. */
  const aclOf = async (piece: PieceAddress): Promise<unknown> => {
    const address = {
      id: aclDocId(piece.space as `did:${string}:${string}`),
      space: piece.space,
    };
    // Reading the document through a cell is what loads it into the owner's
    // replica; the raw read then returns it as stored.
    await owner.client().call("readAddress", {
      link: { ...address, path: [], type: "application/json" },
    });
    return ((await owner.rawRead(address)).value as { value?: unknown }).value;
  };

  /** The offers the owner reads in `piece`, the private inbox by default. */
  const ownerOffers = async (
    piece: PieceAddress = inbox,
  ): Promise<ReadOffer[]> =>
    (await owner.read(["offers"], { piece })) as ReadOffer[];

  /**
   * How many commits the CFC write gate has refused, in the sender's runtime
   * and in this process, where the serving loop runs. The gate counts each
   * refusal whatever the log level shows.
   */
  const refusals = async (
    from: MultiRuntimeSession = sender,
  ): Promise<number> =>
    writeRefusals(await from.loggerCounts()) +
    writeRefusals(getLoggerCountsBreakdown());

  /**
   * Has `from`'s own handler send an offer, keyed `id`, through a profile, by
   * default the owner's first, and waits for the owner to read it in `to`, by
   * default the private inbox, or for the append to be refused, then asserts
   * the first. The append is a consequence of a consequence, which a
   * `settle()` does not wait for.
   */
  const offer = async (
    title: string,
    stream: "offer" | "queuedOffer" | "offerToReadopting" = "offer",
    id: string = title,
    from: MultiRuntimeSession = sender,
    to: PieceAddress = inbox,
  ): Promise<void> => {
    const refusedBefore = await refusals(from);
    await from.send(stream, { id, space: harness.spaceDid, title });
    await harness.settleUntil(async () =>
      (await ownerOffers(to)).some((each) => each.title === title) ||
      await refusals(from) > refusedBefore
    );
    expect(await refusals(from)).toBe(refusedBefore);
    expect((await ownerOffers(to)).map((each) => each.title)).toContain(title);
  };

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

    // A current profile and one of an earlier vintage, neither pointing at an
    // inbox, so that Home creates one.
    await owner.send("createProfile");
    await owner.send("createEarlierProfile");
    await owner.send("createOtherInbox");
    await owner.send("createLoomInbox");
    await stranger.send("createStrangerInbox");
    await harness.settle();

    created = await ensureThroughHost([]);
    await harness.settleUntil(async () =>
      await pointed(["profiles", 0]) && await pointed(["profiles", 1])
    );
    inbox = await owner.link(["privateInbox", "piece"]);

    // `adoptingHome`: two current profiles and two of an earlier vintage. The
    // second points at an inbox of the owner's shaped as a loom daemon's, and
    // the third at the owner's other inbox.
    await owner.send("createAdoptingProfile");
    await owner.send("createAdoptingProfile");
    await owner.send("createAdoptingEarlierProfile");
    await owner.send("createAdoptingEarlierProfile");
    await harness.settle();
    await owner.send("pointAdoptingProfileAtLoom", { index: 1 });
    await owner.send("pointAdoptingProfileAtOther", { index: 2 });
    await harness.settleUntil(async () =>
      await pointed(["adoptingHome", "profiles", 1]) &&
      await pointed(["adoptingHome", "profiles", 2])
    );

    adoption = await ensureThroughHost(["adoptingHome"]);
    await harness.settleUntil(async () =>
      await pointed(["adoptingHome", "profiles", 0]) &&
      await pointed(["adoptingHome", "profiles", 3])
    );
    adopted = await owner.link(["adoptingHome", "privateInbox", "piece"]);

    // `refusingHome`: two profiles, the second pointing at the stranger's
    // inbox, which the owner does not own.
    await owner.send("createRefusingProfile");
    await owner.send("createRefusingProfile");
    await harness.settle();
    await owner.send("pointRefusingProfileAtStranger", { index: 1 });
    await harness.settleUntil(async () =>
      await pointed(["refusingHome", "profiles", 1])
    );

    refusalsBefore = await adoptionRefusals();
    refusal = await ensureThroughHost(["refusingHome"]);
    await harness.settle();

    // `readoptingHome`: one profile. Home creates its inbox and points the
    // profile at it, and a sender delivers an offer there. The profile is
    // then pointed at another inbox of the owner's, shaped as a loom
    // daemon's, as when the daemon writes the pointer last, and Home is
    // ensured again.
    await owner.send("createReadoptingProfile");
    await owner.send("createReadoptLoomInbox");
    await harness.settle();
    readoptCreated = await ensureThroughHost(["readoptingHome"]);
    await harness.settleUntil(async () =>
      await pointed(["readoptingHome", "profiles", 0])
    );
    readoptOriginal = await owner.link([
      "readoptingHome",
      "privateInbox",
      "piece",
    ]);
    await offer(
      "before the switch",
      "offerToReadopting",
      "before the switch",
      sender,
      readoptOriginal,
    );
    const readoptLoom = await owner.link(["readoptLoomInbox", "piece"]);
    await owner.send("pointReadoptingProfileAtLoom", { index: 0 });
    await harness.settleUntil(async () =>
      (await owner.link(["readoptingHome", "profiles", 0, "inbox", "piece"]))
        .id === readoptLoom.id
    );
    readoption = await ensureThroughHost(["readoptingHome"]);
    await harness.settleUntil(async () =>
      (await owner.link(["readoptingHome", "privateInbox", "piece"])).id ===
        readoptLoom.id
    );
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("creates the inbox in a space of its own that grants every principal WRITE, when no profile advertises one", async () => {
    expect(created.outcome).toBe("none-advertised");
    expect(inbox.space).not.toBe(harness.spaceDid);
    expect(await aclOf(inbox)).toEqual({
      [owner.identity.did()]: "OWNER",
      "*": "WRITE",
    });
  });

  it("points each profile with no inbox at it, current and earlier vintage", async () => {
    expect((await profileInbox(0)).id).toBe(inbox.id);
    expect((await profileInbox(1)).id).toBe(inbox.id);
  });

  it("creates and re-points nothing when ensured again, and leaves a profile pointing at another inbox as it was", async () => {
    const other = await owner.link(["otherInbox", "piece"]);
    const count = ((await owner.readRaw(["profiles"])) as unknown[]).length;
    await owner.send("createProfile");
    await owner.send("createEarlierProfile");
    await harness.settle();
    await owner.send("pointProfileElsewhere", { index: count });
    await owner.send("pointProfileElsewhere", { index: count + 1 });
    await harness.settleUntil(async () =>
      await pointed(["profiles", count]) &&
      await pointed(["profiles", count + 1])
    );

    const again = await ensureThroughHost([]);
    await harness.settle();

    expect(again.outcome).toBe("held");
    expect(await owner.link(["privateInbox", "piece"])).toEqual(inbox);
    expect((await profileInbox(0)).id).toBe(inbox.id);
    expect((await profileInbox(1)).id).toBe(inbox.id);
    expect((await profileInbox(count)).id).toBe(other.id);
    expect((await profileInbox(count + 1)).id).toBe(other.id);
    expect(other.id).not.toBe(inbox.id);
  });

  it("adopts the owner's inbox in a space of its own that a profile advertises, and creates none", async () => {
    const loom = await owner.link(["loomInbox", "piece"]);

    expect(await aclOf(loom)).toEqual({
      [owner.identity.did()]: "OWNER",
      "*": "WRITE",
    });
    expect(adoption.outcome).toBe("adopt");
    expect(adoption.inbox).toEqual({ id: loom.id, space: loom.space });
    expect(adopted.id).toBe(loom.id);
    expect(adopted.space).toBe(loom.space);
  });

  it("points the adopting Home's profiles with no inbox at the adopted inbox, current and earlier vintage", async () => {
    expect((await adoptingProfileInbox(0)).id).toBe(adopted.id);
    expect((await adoptingProfileInbox(1)).id).toBe(adopted.id);
    expect((await adoptingProfileInbox(3)).id).toBe(adopted.id);
  });

  it("leaves the adopting Home's profile pointing at a different inbox as it was", async () => {
    const other = await owner.link(["otherInbox", "piece"]);

    expect((await adoptingProfileInbox(2)).id).toBe(other.id);
    expect(other.id).not.toBe(adopted.id);
  });

  it("refuses another principal's advertised inbox, adopting and creating none, and logs the refusal", async () => {
    const strangers = await owner.link(["strangerInbox", "piece"]);

    expect(await aclOf(strangers)).toEqual({
      [stranger.identity.did()]: "OWNER",
      "*": "WRITE",
    });
    expect(refusal.outcome).toBe("refused");
    expect(refusal.reason).toBe("inbox-adoption-acl-mismatch");
    expect(await owner.read(["refusingHome", "privateInbox", "piece"]))
      .toBeUndefined();
    expect(await adoptionRefusals()).toBe(refusalsBefore + 1);
  });

  it("leaves the refusing Home's pointers as they were, the unpointed one included", async () => {
    const strangers = await owner.link(["strangerInbox", "piece"]);

    expect(
      (await owner.link(["refusingHome", "profiles", 1, "inbox", "piece"])).id,
    ).toBe(strangers.id);
    expect(await pointed(["refusingHome", "profiles", 0])).toBe(false);
  });

  it("adopts the inbox its profile is pointed at once no profile advertises the inbox it holds, and retains that one", async () => {
    const loom = await owner.link(["readoptLoomInbox", "piece"]);

    expect(readoptCreated.outcome).toBe("none-advertised");
    expect(readoptOriginal.id).not.toBe(loom.id);
    expect(readoption.outcome).toBe("adopt");
    expect(readoption.inbox).toEqual({ id: loom.id, space: loom.space });
    const held = await owner.link(["readoptingHome", "privateInbox", "piece"]);
    expect(held.id).toBe(loom.id);
    expect(held.space).toBe(loom.space);
    const retained = await owner.link([
      "readoptingHome",
      "retainedPrivateInboxes",
      0,
    ]);
    expect(retained.id).toBe(readoptOriginal.id);
    expect(retained.space).toBe(readoptOriginal.space);
    expect(
      ((await owner.readRaw([
        "readoptingHome",
        "retainedPrivateInboxes",
      ])) as unknown[]).length,
    ).toBe(1);
  });

  it("keeps an offer delivered to the inbox it held readable through the retained link", async () => {
    const retained = await owner.link([
      "readoptingHome",
      "retainedPrivateInboxes",
      0,
    ]);

    const offers = await ownerOffers(retained);
    expect(offers.map((each) => each.title)).toContain("before the switch");
    expect(
      offers.find((each) => each.title === "before the switch")?.from,
    ).toBe(sender.identity.did());
  });

  it("keeps the adopted inbox and retains nothing more when ensured again", async () => {
    const loom = await owner.link(["readoptLoomInbox", "piece"]);

    const again = await ensureThroughHost(["readoptingHome"]);
    await harness.settle();

    expect(again.outcome).toBe("held");
    expect(
      (await owner.link(["readoptingHome", "privateInbox", "piece"])).id,
    ).toBe(loom.id);
    expect(
      ((await owner.readRaw([
        "readoptingHome",
        "retainedPrivateInboxes",
      ])) as unknown[]).length,
    ).toBe(1);
  });

  it("points a profile created through the profile-create surface after the inbox exists", async () => {
    const count = ((await owner.readRaw(["profiles"])) as unknown[]).length;
    await owner.send("createProfileThroughSurface", { name: "Later" });
    await harness.settleUntil(async () =>
      (await owner.read(["profiles", count, "inbox", "piece"])) !== undefined
    );

    expect((await profileInbox(count)).id).toBe(inbox.id);
  });

  it("delivers each offer a sender's own handler sends, from the sender", async () => {
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
      expect(each.id).toBe(each.title);
      expect(each.space).toBe(harness.spaceDid);
      expect(each.host).toBe("https://example.com");
      expect(each.ownerOrigin).toBe("https://example.com");
      expect(each.from).toBe(sender.identity.did());
      expect(typeof each.sharedAt).toBe("number");
      expect(typeof each.receivedAt).toBe("number");
    }
  });

  it("delivers each offer a queued handler of the sender's sends after reading the pointer, from the sender", async () => {
    const before = (await ownerOffers()).length;

    for (const title of ["queued first", "queued second"]) {
      await offer(title, "queuedOffer");
    }

    // `receive` keeps an offer only when its `from` is `currentPrincipal()`,
    // which is the sender whose event started the cascade, not the inbox's
    // owner.
    const offers = (await ownerOffers()).slice(before);
    expect(offers.map((each) => each.title)).toEqual([
      "queued first",
      "queued second",
    ]);
    for (const each of offers) {
      expect(each.kind).toBe("fabrichat-room");
      expect(each.space).toBe(harness.spaceDid);
      expect(each.from).toBe(sender.identity.did());
      expect(each.from).not.toBe(owner.identity.did());
    }
  });

  it("keeps an offer from each of two senders using one id", async () => {
    await offer("shared id, from the sender", "offer", "shared id");
    await offer("shared id, from the stranger", "offer", "shared id", stranger);

    const shared = (await ownerOffers()).filter((each) =>
      each.id === "shared id"
    );
    expect(shared.map((each) => each.from).sort()).toEqual(
      [sender.identity.did(), stranger.identity.did()].sort(),
    );
  });

  it("lets a sender read the offers back and find its own", async () => {
    // The space grants every principal `WRITE`, which implies `READ`, and the
    // offers' label binds no runtime that reads without a ceiling, so a
    // sender can confirm its delivery by reading the inbox for a row with its
    // offer's `id`, `from` and `space`, as a loom sender does.
    await offer("read back");

    const offers = (await sender.read(["offers"], {
      piece: inbox,
    })) as ReadOffer[];
    expect(
      offers.some((each) =>
        each.id === "read back" && each.from === sender.identity.did() &&
        each.space === harness.spaceDid
      ),
    ).toBe(true);
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
