/**
 * The multi-runtime harness driving the system private inbox: its owner
 * creates it and has their profiles point at it, current and earlier vintages
 * alike, a sender's own handler delivers offers to the inbox the owner's
 * profile points at, and a stranger tries to read them. Two more Homes, whose
 * profiles already point at inboxes, are given their inboxes by the host: one
 * adopts an inbox shaped as a loom daemon's rather than creating one, and the
 * other is refused another principal's inbox, holds none, and records the
 * refusal. Two more Homes record the same refusal, and clear it: one when its
 * profile is pointed at a usable inbox and it adopts that one, the other when
 * its profile leaves its list and it creates one. Another, of the
 * vintage whose ensure takes no refusal, is sent one and handles the event
 * without it. A last Home creates its inbox and points both its profiles at
 * it; once its default profile is pointed at an inbox shaped as a loom
 * daemon's, as when the daemon writes the pointer last, it adopts that one,
 * though its other profile still points at the first, and retains the one it
 * held, whose offers stay readable. A Home whose profile keeps its pointer
 * per user creates no inbox while that profile advertises one. A Home refused
 * another principal's inbox has it replaced by its owner: a send of the
 * replacement that no click on the refusal notice's button marks is refused,
 * and a marked one creates the Home's own inbox and points the refused
 * profile at it, including when the refused inbox's space has stopped letting
 * the owner read it. A client requests a Home's inbox, as a loom daemon does,
 * for two of its profiles at once, and reads, from each handling's receipt,
 * the one inbox Home creates and both profiles point at; each receipt links to
 * Home's one answer for its profile. A request for a profile pointed elsewhere
 * reads `not-held`, one for a profile without `setInbox` `unpointable`, one to
 * a Home with no profiles `unlisted`, and one to a Home without the stream
 * sends nothing. Two runtimes of the owner's each point one profile at an
 * inbox of their own, only while it points at none, with both sends in
 * flight at once, and the profile keeps the one the server admits first.
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

/**
 * The trusted surface and action of the button on Home's refusal notice, as
 * `packages/patterns/system/private-inbox.tsx` declares them
 * (`TRUSTED_PRIVATE_INBOX_REFUSAL_SURFACE`,
 * `TRUSTED_REPLACE_REFUSED_INBOX_ACTION`). Named here rather than imported: the
 * pattern module compiles only in the runtime, and the event is matched by
 * string either way.
 */
const REPLACE_CLICK = {
  surface: "PrivateInboxRefusalSurface",
  action: "ReplaceRefusedPrivateInbox",
};

/** What the host found when it ensured a Home's inbox. */
type HostEnsure = {
  outcome: string;
  reason?: string;
  inbox?: { id: string; space: string };
  profile?: { id: string; space: string };
};

/**
 * What a client learned when it requested a Home's inbox: Home's answer, the
 * inbox it names, and the inbox the profile it named points at once Home had
 * answered.
 */
type RequestAnswer = {
  status: string;
  inbox?: { id: string; space: string };
  pointer?: { id: string; space: string };
};

/**
 * A request's receipt, read back raw: its own address, and the document and
 * path it links to.
 */
type RequestReceipt = {
  receipt: { id: string; space: string };
  id: string;
  path: string[];
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

/**
 * A function that runs `build` on its first call and returns the promise that
 * call made, on that call and every later one.
 *
 * Each Home stand-in's setup is one of these, called by the steps that read
 * it. A lane that runs one step of this file registers the others as ignored,
 * and a setup that ran whatever the lane chose would cost every such lane the
 * whole file's.
 */
const once = <T>(build: () => Promise<T>): () => Promise<T> => {
  let built: Promise<T> | undefined;
  return () => built ??= build();
};

describe("private inbox across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let owner: MultiRuntimeSession;
  let sender: MultiRuntimeSession;
  let stranger: MultiRuntimeSession;
  let inbox: PieceAddress;
  let created: HostEnsure;

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

  /**
   * Has the owner's runtime request the inbox of the Home stand-in at `path`,
   * as a loom daemon does, naming its profile at `profile`.
   */
  const requestInbox = async (
    path: string[],
    profile: (string | number)[],
  ): Promise<RequestAnswer> =>
    await owner.client().call("requestPrivateInbox", {
      path,
      profile,
    }) as RequestAnswer;

  /**
   * Has the owner's runtime send the request `requestInbox` does, and returns
   * the receipt as `requestReceipt` reads it back.
   */
  const requestReceipt = async (
    path: string[],
    profile: (string | number)[],
  ): Promise<RequestReceipt> =>
    await owner.client().call("requestReceipt", {
      path,
      profile,
    }) as RequestReceipt;

  /** The status the receipt `receipt` reads, following the link it holds. */
  const readReceipt = async (receipt: RequestReceipt): Promise<unknown> =>
    await owner.client().call("readReceiptStatus", {
      receipt: receipt.receipt,
    });

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

  /** The entries of the stream sidecar `id` in `space`, as stored. */
  const streamEntries = async (
    space: string,
    id: string,
  ): Promise<Record<string, unknown>[]> => {
    const address = { id, space };
    await owner.client().call("readAddress", {
      link: { ...address, path: [], type: "application/json" },
    });
    const stored = (await owner.rawRead(address)).value as
      | { value?: { entries?: Record<string, unknown>[] } }
      | undefined;
    return stored?.value?.entries ?? [];
  };

  /** Whether the drain has finished with a stream entry, however it ended. */
  const terminal = (entry: Record<string, unknown>): boolean =>
    entry.consequenced === true || entry.error !== undefined ||
    entry.status !== undefined;

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
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  /**
   * `adoptingHome`: two current profiles and two of an earlier vintage. The
   * second points at an inbox of the owner's shaped as a loom daemon's, and
   * the third at the owner's other inbox.
   */
  const adopting = once(async () => {
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

    const adoption = await ensureThroughHost(["adoptingHome"]);
    await harness.settleUntil(async () =>
      await pointed(["adoptingHome", "profiles", 0]) &&
      await pointed(["adoptingHome", "profiles", 3])
    );
    const adopted = await owner.link(["adoptingHome", "privateInbox", "piece"]);
    return { adoption, adopted };
  });

  /**
   * `refusingHome`: two profiles, the second pointing at the stranger's inbox,
   * which the owner does not own.
   */
  const refusing = once(async () => {
    await owner.send("createRefusingProfile");
    await owner.send("createRefusingProfile");
    await harness.settle();
    await owner.send("pointRefusingProfileAtStranger", { index: 1 });
    await harness.settleUntil(async () =>
      await pointed(["refusingHome", "profiles", 1])
    );

    const refusalsBefore = await adoptionRefusals();
    const refusal = await ensureThroughHost(["refusingHome"]);
    await harness.settle();
    const refusalsAfter = await adoptionRefusals();
    return { refusal, refusalsBefore, refusalsAfter };
  });

  /**
   * `racingHome`: one profile, which the owner's runtime points at the
   * loom-shaped inbox, only while it points at none. Once that send's
   * consequence has arrived back and both runtimes have caught up, a second
   * runtime of the owner's points it at the other inbox, again only while it
   * points at none. Returns the inbox the profile pointed at after the first
   * send, and the inbox each runtime reads it pointing at once the second
   * send's `setInbox` has run.
   */
  const racing = once(async () => {
    const ownerAgain = await harness.addSession({
      label: "private-inbox-owner-again",
      identity: owner.identity,
    });
    await owner.send("createRacingProfile");
    await harness.settle();
    const held = ["racingHome", "profiles", 0, "inbox", "piece"];
    const pointer = await owner.link(["racingHome", "profiles", 0, "inbox"]);
    const admitted = await harness.admittedCommitsDuring(async () => {
      await owner.send("pointRacingProfileAtLoomIfUnset", { index: 0 });
      await owner.awaitEventConsequences();
      await harness.settleUntil(async () =>
        await pointed(["racingHome", "profiles", 0])
      );
    });
    const first = await owner.link(held);
    // With server execution on, each send reaches the profile's `setInbox`
    // as an entry in that stream's sidecar, appended by a commit in the
    // profile's space. The second send's expected outcome is no change, so
    // what says it has run is its entry's terminal mark, not the pointer.
    const sidecars = new Set(
      admitted.filter((commit) => commit.space === pointer.space)
        .flatMap((commit) => commit.eventAppends ?? [])
        .map((append) => append.id),
    );
    await ownerAgain.send("pointRacingProfileAtOtherIfUnset", { index: 0 });
    await ownerAgain.awaitEventConsequences();
    if (SERVER_EXECUTION) {
      expect(sidecars.size).toBe(1);
      const [sidecar] = sidecars;
      let entries: Record<string, unknown>[] = [];
      await harness.settleUntil(async () => {
        entries = await streamEntries(pointer.space, sidecar);
        return entries.length === 2 && entries.every(terminal);
      });
      // A handler that threw, or an entry that was dropped, also leaves the
      // pointer as it was, so each entry has to have run to completion.
      expect(
        entries.filter((entry) =>
          entry.error !== undefined || entry.status !== undefined
        ),
      ).toEqual([]);
    }
    await harness.settle();
    return {
      first,
      ownerReads: await owner.link(held),
      ownerAgainReads: await ownerAgain.link(held),
    };
  });

  /**
   * `curedHome`: two profiles, both pointing at the stranger's inbox. Once the
   * refusal is recorded, the first, the deciding one, is pointed at a usable
   * inbox of the owner's, and the second still points at the stranger's, so
   * only the adoption can clear the record.
   */
  const curing = once(async () => {
    await owner.send("createCuredProfile");
    await owner.send("createCuredProfile");
    await owner.send("createCureInbox");
    await harness.settle();
    await owner.send("pointCuredProfileAtStranger", { index: 0 });
    await owner.send("pointCuredProfileAtStranger", { index: 1 });
    await harness.settleUntil(async () =>
      await pointed(["curedHome", "profiles", 0]) &&
      await pointed(["curedHome", "profiles", 1])
    );
    const curedRefusal = await ensureThroughHost(["curedHome"]);
    await harness.settle();
    const curedRecord = {
      reason: await owner.read([
        "curedHome",
        "privateInboxRefusal",
        "refusal",
        "reason",
      ]),
      inbox: await owner.link([
        "curedHome",
        "privateInboxRefusal",
        "refusal",
        "inbox",
      ]),
    };
    const cure = await owner.link(["cureInbox", "piece"]);
    await owner.send("pointCuredProfileAtCure", { index: 0 });
    await harness.settleUntil(async () =>
      (await owner.link(["curedHome", "profiles", 0, "inbox", "piece"]))
        .id === cure.id
    );
    const curedAdoption = await ensureThroughHost(["curedHome"]);
    await harness.settleUntil(async () =>
      (await owner.read(["curedHome", "privateInbox", "piece"])) !==
        undefined
    );
    return { curedRefusal, curedRecord, curedAdoption };
  });

  /**
   * `creatingHome`: one profile, pointing at the stranger's inbox, which leaves
   * its list once the refusal is recorded.
   */
  const creating = once(async () => {
    await owner.send("createCreatingProfile");
    await harness.settle();
    await owner.send("pointCreatingProfileAtStranger", { index: 0 });
    await harness.settleUntil(async () =>
      await pointed(["creatingHome", "profiles", 0])
    );
    await ensureThroughHost(["creatingHome"]);
    await harness.settle();
    const creatingRecord = {
      reason: await owner.read([
        "creatingHome",
        "privateInboxRefusal",
        "refusal",
        "reason",
      ]),
      inbox: await owner.link([
        "creatingHome",
        "privateInboxRefusal",
        "refusal",
        "inbox",
      ]),
    };
    await owner.send("dropCreatingProfiles");
    await harness.settleUntil(async () =>
      ((await owner.readRaw(["creatingHome", "profiles"])) as unknown[])
        .length === 0
    );
    const creation = await ensureThroughHost(["creatingHome"]);
    await harness.settleUntil(async () =>
      (await owner.read(["creatingHome", "privateInbox", "piece"])) !==
        undefined
    );
    return { creatingRecord, creation };
  });

  /** `olderHome`: one profile, pointing at the stranger's inbox. */
  const older = once(async () => {
    await owner.send("createOlderProfile");
    await harness.settle();
    await owner.send("pointOlderProfileAtStranger", { index: 0 });
    await harness.settleUntil(async () =>
      await pointed(["olderHome", "profiles", 0])
    );
    const olderRefusal = await ensureThroughHost(["olderHome"]);
    await harness.settleUntil(async () =>
      (await owner.read(["olderHome", "handled"])) === 1
    );
    return { olderRefusal };
  });

  /**
   * `readoptingHome`: two profiles. Home creates its inbox and points both at
   * it, and a sender delivers an offer there. The second is made the default
   * and then pointed at another inbox of the owner's, shaped as a loom
   * daemon's, as when the daemon writes the pointer last, and Home is ensured
   * again; the first still points at the inbox Home created.
   */
  const readopting = once(async () => {
    await owner.send("createReadoptingProfile");
    await owner.send("createReadoptingProfile");
    await owner.send("createReadoptLoomInbox");
    await harness.settle();
    const readoptCreated = await ensureThroughHost(["readoptingHome"]);
    await harness.settleUntil(async () =>
      await pointed(["readoptingHome", "profiles", 0]) &&
      await pointed(["readoptingHome", "profiles", 1])
    );
    const readoptOriginal = await owner.link([
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
    await owner.send("setReadoptingDefault", { index: 1 });
    await owner.send("pointReadoptingProfileAtLoom", { index: 1 });
    await harness.settleUntil(async () =>
      (await owner.link(["readoptingHome", "profiles", 1, "inbox", "piece"]))
          .id === readoptLoom.id &&
      (await owner.read(["readoptingHome", "defaultProfile", "profile"])) !==
        undefined
    );
    const readoption = await ensureThroughHost(["readoptingHome"]);
    await harness.settleUntil(async () =>
      (await owner.link(["readoptingHome", "privateInbox", "piece"])).id ===
        readoptLoom.id
    );
    return { readoptCreated, readoptOriginal, readoption };
  });

  /**
   * `replacingHome`: two profiles, the second pointing at the stranger's inbox,
   * which the host refuses. Its replacement is sent once with no click marking
   * it, and then as the refusal notice's button sends it.
   */
  const replacing = once(async () => {
    await owner.send("createReplacingProfile");
    await owner.send("createReplacingProfile");
    await harness.settle();
    await owner.send("pointReplacingProfileAtStranger", { index: 1 });
    await harness.settleUntil(async () =>
      await pointed(["replacingHome", "profiles", 1])
    );
    await ensureThroughHost(["replacingHome"]);
    const replacingReason = ["replacingHome", "privateInboxRefusal", "refusal"];
    await harness.settleUntil(async () =>
      (await owner.read([...replacingReason, "reason"])) !== undefined
    );
    const replacingRefused = await owner.link([...replacingReason, "inbox"]);
    const replacingHeld = ["replacingHome", "privateInbox", "piece"];
    const replacement = [
      "replacingHome",
      "privateInboxReplacement",
      "replacement",
    ];
    const unmarkedBefore = await refusals(owner);
    await owner.send("replaceReplacingInbox");
    await harness.settleUntil(async () =>
      await refusals(owner) > unmarkedBefore ||
      (await owner.read(replacingHeld)) !== undefined
    );
    // Under server execution the handler is refused twice, by the owner's
    // own run and by the served one, and the wait above returns on the
    // first. The served refusal is the event's consequence, so once that is
    // back, neither refusal can land in the marked replacement's count.
    await owner.awaitEventConsequences();
    const unmarkedReplacement = {
      refusals: await refusals(owner) - unmarkedBefore,
      held: await owner.read(replacingHeld),
      reason: await owner.read([...replacingReason, "reason"]),
      replacement: await owner.read(replacement),
    };
    const markedBefore = await refusals(owner);
    await owner.send("replaceReplacingInbox", {}, REPLACE_CLICK);
    await harness.settleUntil(async () =>
      await refusals(owner) > markedBefore ||
      ((await owner.read(replacingHeld)) !== undefined &&
        (await owner.link(["replacingHome", "profiles", 1, "inbox", "piece"]))
            .id === (await owner.link(replacingHeld)).id)
    );
    const markedReplacementRefusals = await refusals(owner) - markedBefore;
    return { replacingRefused, unmarkedReplacement, markedReplacementRefusals };
  });

  /**
   * `requestingHome`: two profiles pointing at no inbox, whose inbox a client
   * requests for both at once. Two more requests are read back as stored, and
   * the second profile is pointed at the loom-shaped inbox and requested for
   * again, as when something other than Home wins its pointer. A third
   * profile, of a vintage without `setInbox`, is added and requested for.
   */
  const requesting = once(async () => {
    await owner.send("createRequestingProfile");
    await owner.send("createRequestingProfile");
    await harness.settle();
    const requested = await Promise.all([
      requestInbox(["requestingHome"], ["requestingHome", "profiles", 0]),
      requestInbox(["requestingHome"], ["requestingHome", "profiles", 1]),
    ]);
    const receipts: RequestReceipt[] = [];
    for (const index of [0, 1]) {
      receipts.push(
        await requestReceipt(["requestingHome"], [
          "requestingHome",
          "profiles",
          index,
        ]),
      );
    }
    const loom = await owner.link(["loomInbox", "piece"]);
    await owner.send("pointRequestingProfileAtLoom", { index: 1 });
    await harness.settleUntil(async () =>
      (await owner.link(["requestingHome", "profiles", 1, "inbox", "piece"]))
        .id === loom.id
    );
    const contestedRequest = await requestInbox(
      ["requestingHome"],
      ["requestingHome", "profiles", 1],
    );
    await owner.send("createRequestingPointerOnlyProfile");
    await harness.settleUntil(async () =>
      ((await owner.readRaw(["requestingHome", "profiles"])) as unknown[])
        .length === 3
    );
    const pointerOnlyRequest = await requestInbox(
      ["requestingHome"],
      ["requestingHome", "profiles", 2],
    );
    return { requested, receipts, contestedRequest, pointerOnlyRequest };
  });

  /**
   * `leavingHome`: three profiles. The first two are requested for, and once
   * their receipts read `ensured`, the third is pointed at the loom-shaped
   * inbox and the first leaves the list, which moves the second and third up
   * one place.
   */
  const leaving = once(async () => {
    for (let index = 0; index < 3; index++) {
      await owner.send("createLeavingProfile");
    }
    await harness.settleUntil(async () =>
      ((await owner.readRaw(["leavingHome", "profiles"])) as unknown[])
        .length === 3
    );
    const leavingReceipts: RequestReceipt[] = [];
    for (const index of [0, 1]) {
      leavingReceipts.push(
        await requestReceipt(["leavingHome"], [
          "leavingHome",
          "profiles",
          index,
        ]),
      );
    }
    const statuses = async () =>
      await Promise.all(
        leavingReceipts.map(readReceipt),
      );
    await harness.settleUntil(async () =>
      (await statuses()).every((status) => status === "ensured")
    );
    const before = await statuses();
    const loomLink = await owner.link(["loomInbox", "piece"]);
    await owner.send("pointLeavingProfileAtLoom", { index: 2 });
    await harness.settleUntil(async () =>
      (await owner.link(["leavingHome", "profiles", 2, "inbox", "piece"]))
        .id === loomLink.id
    );
    await owner.send("dropLeavingFirstProfile");
    await harness.settleUntil(async () =>
      ((await owner.readRaw(["leavingHome", "profiles"])) as unknown[])
        .length === 2
    );
    await harness.settle();
    return { before, after: await statuses() };
  });

  /**
   * `profilelessHome`: no profiles, requested for a profile of
   * `requestingHome`'s.
   */
  const profileless = once(async () => {
    await requesting();
    const profilelessRequest = await requestInbox(
      ["profilelessHome"],
      ["requestingHome", "profiles", 0],
    );
    await harness.settleUntil(async () =>
      (await owner.read(["profilelessHome", "privateInbox", "piece"])) !==
        undefined
    );
    return { profilelessRequest };
  });

  /** `olderHome`, which has no stream to request through, requested for. */
  const olderRequesting = once(async () => {
    await older();
    const olderHandledBefore = await owner.read(["olderHome", "handled"]);
    const olderRequest = await requestInbox(
      ["olderHome"],
      ["olderHome", "profiles", 0],
    );
    await harness.settle();
    return { olderHandledBefore, olderRequest };
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
    const { adoption, adopted } = await adopting();
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
    const { adopted } = await adopting();

    expect((await adoptingProfileInbox(0)).id).toBe(adopted.id);
    expect((await adoptingProfileInbox(1)).id).toBe(adopted.id);
    expect((await adoptingProfileInbox(3)).id).toBe(adopted.id);
  });

  it("leaves the adopting Home's profile pointing at a different inbox as it was", async () => {
    const { adopted } = await adopting();
    const other = await owner.link(["otherInbox", "piece"]);

    expect((await adoptingProfileInbox(2)).id).toBe(other.id);
    expect(other.id).not.toBe(adopted.id);
  });

  it("refuses another principal's advertised inbox, adopting and creating none, and logs the refusal", async () => {
    const { refusal, refusalsBefore, refusalsAfter } = await refusing();
    const strangers = await owner.link(["strangerInbox", "piece"]);

    expect(await aclOf(strangers)).toEqual({
      [stranger.identity.did()]: "OWNER",
      "*": "WRITE",
    });
    expect(refusal.outcome).toBe("refused");
    expect(refusal.reason).toBe("inbox-adoption-acl-mismatch");
    expect(await owner.read(["refusingHome", "privateInbox", "piece"]))
      .toBeUndefined();
    expect(refusalsAfter).toBe(refusalsBefore + 1);
  });

  it("records the refusal on the refusing Home, naming the reason and the refused inbox", async () => {
    await refusing();
    const strangers = await owner.link(["strangerInbox", "piece"]);

    expect(
      await owner.read([
        "refusingHome",
        "privateInboxRefusal",
        "refusal",
        "reason",
      ]),
    ).toBe("inbox-adoption-acl-mismatch");
    const recorded = await owner.link([
      "refusingHome",
      "privateInboxRefusal",
      "refusal",
      "inbox",
    ]);
    expect(recorded.id).toBe(strangers.id);
    expect(recorded.space).toBe(strangers.space);
    expect(
      typeof await owner.read([
        "refusingHome",
        "privateInboxRefusal",
        "refusal",
        "refusedAt",
      ]),
    ).toBe("number");
  });

  it("clears a recorded refusal when the refused profile is pointed at a usable inbox and the next ensure adopts it", async () => {
    // Another profile still points at the refused inbox, so the adoption's
    // clear is the one that clears the record here.
    const { curedRefusal, curedRecord, curedAdoption } = await curing();
    const strangers = await owner.link(["strangerInbox", "piece"]);
    const cure = await owner.link(["cureInbox", "piece"]);

    expect(curedRefusal.outcome).toBe("refused");
    expect(curedRecord.reason).toBe("inbox-adoption-acl-mismatch");
    expect(curedRecord.inbox.id).toBe(strangers.id);
    expect(curedAdoption.outcome).toBe("adopt");
    expect(
      (await owner.link(["curedHome", "privateInbox", "piece"])).id,
    ).toBe(cure.id);
    expect(await owner.read(["curedHome", "privateInboxRefusal"])).toEqual({});
    expect(
      (await owner.link(["curedHome", "profiles", 1, "inbox", "piece"])).id,
    ).toBe(strangers.id);
  });

  it("clears a recorded refusal when no profile advertises an inbox and the next ensure creates one", async () => {
    // Home creates an inbox only while no profile advertises one, so here the
    // clear that creation makes and the clear for no profile pointing at the
    // refused inbox coincide; this case pins the pair, not either alone.
    const { creatingRecord, creation } = await creating();
    const strangers = await owner.link(["strangerInbox", "piece"]);

    expect(creatingRecord.reason).toBe("inbox-adoption-acl-mismatch");
    expect(creatingRecord.inbox.id).toBe(strangers.id);
    expect(creation.outcome).toBe("none-advertised");
    expect(
      (await owner.link(["creatingHome", "privateInbox", "piece"])).space,
    ).not.toBe(strangers.space);
    expect(await owner.read(["creatingHome", "privateInboxRefusal"]))
      .toEqual({});
  });

  it("delivers a refusal to an older Home's ensure without the field it does not declare", async () => {
    const { olderRefusal } = await older();

    expect(olderRefusal.outcome).toBe("refused");
    expect(olderRefusal.reason).toBe("inbox-adoption-acl-mismatch");
    expect(await owner.read(["olderHome", "handled"])).toBe(1);
    expect(await owner.read(["olderHome", "delivered"])).toEqual(["from"]);
    expect(await owner.read(["olderHome", "privateInbox", "piece"]))
      .toBeUndefined();
  });

  it("leaves the refusing Home's pointers as they were, the unpointed one included", async () => {
    await refusing();
    const strangers = await owner.link(["strangerInbox", "piece"]);

    expect(
      (await owner.link(["refusingHome", "profiles", 1, "inbox", "piece"])).id,
    ).toBe(strangers.id);
    expect(await pointed(["refusingHome", "profiles", 0])).toBe(false);
  });

  it("adopts the inbox its default profile is pointed at, though another profile still points at the one it holds, and retains that one", async () => {
    const { readoptCreated, readoptOriginal, readoption } = await readopting();
    const loom = await owner.link(["readoptLoomInbox", "piece"]);
    const deciding = await owner.link(["readoptingHome", "profiles", 1]);

    expect(readoptCreated.outcome).toBe("none-advertised");
    expect(readoptOriginal.id).not.toBe(loom.id);
    expect(readoption.outcome).toBe("adopt");
    expect(readoption.inbox).toEqual({ id: loom.id, space: loom.space });
    expect(readoption.profile?.space).toBe(deciding.space);
    expect(
      (await owner.link(["readoptingHome", "profiles", 0, "inbox", "piece"]))
        .id,
    ).toBe(readoptOriginal.id);
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
    await readopting();
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

  it("keeps the adopted inbox, retains nothing more and points a profile created since when ensured again", async () => {
    // The adopted inbox's link names its result document, so Home's holder
    // carries the offers' label now; the pointing waits on the ensure's own
    // run having committed.
    await readopting();
    const loom = await owner.link(["readoptLoomInbox", "piece"]);
    await owner.send("createReadoptingProfile");
    await harness.settle();

    const again = await ensureThroughHost(["readoptingHome"]);
    await harness.settleUntil(async () =>
      await pointed(["readoptingHome", "profiles", 2])
    );

    expect(again.outcome).toBe("held");
    expect(
      (await owner.link(["readoptingHome", "privateInbox", "piece"])).id,
    ).toBe(loom.id);
    expect(
      (await owner.link(["readoptingHome", "profiles", 2, "inbox", "piece"]))
        .id,
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

  it("refuses a replacement of the refused inbox that no click on the refusal notice's button marks, and changes nothing", async () => {
    const { unmarkedReplacement } = await replacing();

    expect(unmarkedReplacement.refusals).toBeGreaterThan(0);
    expect(unmarkedReplacement.held).toBeUndefined();
    expect(unmarkedReplacement.reason).toBe("inbox-adoption-acl-mismatch");
    expect(unmarkedReplacement.replacement).toBeUndefined();
  });

  it("replaces the refused inbox on a click on the refusal notice's button with one of its own, and points the refused profile at it", async () => {
    const { replacingRefused, markedReplacementRefusals } = await replacing();

    expect(markedReplacementRefusals).toBe(0);
    const held = await owner.link(["replacingHome", "privateInbox", "piece"]);
    expect(held.space).not.toBe(replacingRefused.space);
    expect(held.space).not.toBe(harness.spaceDid);
    expect(
      (await owner.link(["replacingHome", "profiles", 1, "inbox", "piece"]))
        .id,
    ).toBe(held.id);
    expect(
      await owner.read(["replacingHome", "privateInboxRefusal", "refusal"]),
    ).toBeUndefined();
    const replaced = [
      "replacingHome",
      "privateInboxReplacement",
      "replacement",
    ];
    expect(await owner.read([...replaced, "reason"])).toBe(
      "inbox-adoption-acl-mismatch",
    );
    expect((await owner.link([...replaced, "inbox"])).id).toBe(
      replacingRefused.id,
    );
    expect(await owner.read([...replaced, "replacedAt"])).toBeGreaterThan(0);
    expect(
      await owner.read(["replacingHome", "retainedPrivateInboxes"]),
    ).toEqual([]);
  });

  it("keeps a profile's pointer when a second runtime of the owner's points it only while unset after the first has set it", async () => {
    // The second send's `setInbox` runs after the first one's consequence has
    // arrived back, so it reads the pointer the first one set, whichever
    // runtime runs it. With server execution on, the event reaches the
    // profile's space through the serving loop's outbox, and keeps its
    // `replacing: undefined` only if that delivery does.

    const { first, ownerReads, ownerAgainReads } = await racing();

    const loom = await owner.link(["loomInbox", "piece"]);
    expect(first.id).toBe(loom.id);
    expect(ownerReads.id).toBe(loom.id);
    expect(ownerAgainReads.id).toBe(loom.id);
  });

  it("creates no inbox while a profile whose pointer it cannot read advertises one", async () => {
    // The profile keeps its pointer per user in a space of its own. With
    // server execution on, the Home's serving runtime refuses to read that
    // pointer, so the ensure would see a profile advertising nothing; it
    // fails instead, and Home holds no inbox. With it off, the owner's
    // runtime reads the pointer, and Home creates nothing either.
    await owner.send("createUnreadableProfile");
    await harness.settle();
    await owner.send("pointUnreadableProfileAtLoom", { index: 0 });
    await harness.settleUntil(async () =>
      await pointed(["unreadableHome", "profiles", 0])
    );

    await owner.send("ensureUnreadable", {});
    await harness.settle();

    expect(await owner.read(["unreadableHome", "privateInbox", "piece"]))
      .toBeUndefined();
  });

  it("answers a request with the inbox Home holds, once the profile it names points at it", async () => {
    const { requested } = await requesting();
    const held = await owner.link(["requestingHome", "privateInbox", "piece"]);
    expect(requested[0]).toEqual({
      status: "ensured",
      inbox: { id: held.id, space: held.space },
      pointer: { id: held.id, space: held.space },
    });
  });

  it("answers two requests made at once with the one inbox", async () => {
    const { requested } = await requesting();

    expect(requested[1].status).toBe("ensured");
    expect(requested[1].inbox).toEqual(requested[0].inbox);
    expect(requested[1].pointer).toEqual(requested[0].inbox);
  });

  it("links each request's receipt to Home's one answer for the profile, launching nothing per request", async () => {
    const { receipts } = await requesting();

    expect(receipts).toHaveLength(2);
    const [forFirst, forSecond] = receipts;
    expect(forFirst?.id).toBeDefined();
    expect(forSecond?.id).toBe(forFirst?.id);
    expect(forFirst?.path[0]).toBe("profiles");
    expect(forSecond?.path[0]).toBe("profiles");
    expect(forSecond?.path[1]).not.toBe(forFirst?.path[1]);
  });

  it("keeps a receipt answering for its own profile when an earlier profile leaves Home's list, and answers `unlisted` for the one that left", async () => {
    const leavingAnswers = await leaving();

    expect(leavingAnswers.before).toEqual(["ensured", "ensured"]);
    expect(leavingAnswers.after).toEqual(["unlisted", "ensured"]);
  });

  it("answers `not-held` for a profile something other than Home has pointed at another inbox", async () => {
    const { contestedRequest } = await requesting();
    const loom = await owner.link(["loomInbox", "piece"]);
    expect(contestedRequest).toEqual({
      status: "not-held",
      pointer: { id: loom.id, space: loom.space },
    });
  });

  it("answers `unpointable` for a profile without `setInbox`", async () => {
    const { pointerOnlyRequest } = await requesting();

    expect(pointerOnlyRequest.status).toBe("unpointable");
    expect(pointerOnlyRequest.inbox).toBeUndefined();
  });

  it("answers a request to a Home with no profiles as unlisted, and creates the Home's inbox", async () => {
    const { requested } = await requesting();
    const { profilelessRequest } = await profileless();

    expect(profilelessRequest.status).toBe("unlisted");
    expect(profilelessRequest.inbox).toBeUndefined();
    expect(await owner.read(["profilelessHome", "profiles"])).toEqual([]);
    expect(
      (await owner.link(["profilelessHome", "privateInbox", "piece"])).id,
    ).not.toBe(requested[0].inbox?.id);
  });

  it("sends nothing to a Home without the stream, and reports it unavailable", async () => {
    const { olderHandledBefore, olderRequest } = await olderRequesting();

    expect(olderRequest.status).toBe("unavailable");
    expect(await owner.read(["olderHome", "handled"])).toBe(
      olderHandledBefore,
    );
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

    // The inbox lives in the owner's space. The sender's replica already
    // holds a copy of it that its subscription keeps current, so the read
    // answers from that copy, and the row appears once the delivery has
    // reached it rather than on the first read after the owner saw it.
    const readsBack = async () => {
      const offers = (await sender.read(["offers"], {
        piece: inbox,
      })) as ReadOffer[];
      return offers.some((each) =>
        each.id === "read back" && each.from === sender.identity.did() &&
        each.space === harness.spaceDid
      );
    };
    await harness.settleUntil(readsBack);
    expect(await readsBack()).toBe(true);

    // What the sender reads is what the inbox holds, row for row. Under
    // server execution the sender's runtime previews its own deliveries, and
    // a preview is a row in a document of its own that the inbox's space
    // never holds, so a sender still reading one has not read its delivery
    // back. A preview stands until the consequence of the event behind it
    // arrives, which is what the comparison waits for.
    await sender.awaitEventConsequences();
    const rows = async (from: MultiRuntimeSession): Promise<string[]> => {
      const count =
        ((await from.read(["offers"], { piece: inbox })) as unknown[]).length;
      const ids: string[] = [];
      for (let index = 0; index < count; index++) {
        ids.push((await from.link(["offers", index], { piece: inbox })).id);
      }
      return ids;
    };
    expect(await rows(sender)).toEqual(await rows(owner));
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

  it("replaces an inbox in Home's own private-inbox space with another piece in that space, leaving the refused one's offers in it", async () => {
    await offer("before the own-space replacement");
    const before = (await ownerOffers(inbox)).map((each) => each.title);
    await owner.send("createOwnSpaceProfile");
    await harness.settle();
    await owner.send("pointOwnSpaceProfileAtPrivateInbox", { index: 0 });
    await harness.settleUntil(async () =>
      await pointed(["ownSpaceHome", "profiles", 0])
    );
    await owner.send("refuseOwnSpaceInbox");
    const refusalPath = ["ownSpaceHome", "privateInboxRefusal", "refusal"];
    await harness.settleUntil(async () =>
      (await owner.read([...refusalPath, "reason"])) !== undefined
    );
    const heldPath = ["ownSpaceHome", "privateInbox", "piece"];
    const refusedBefore = await refusals(owner);
    await owner.send("replaceOwnSpaceInbox", {}, REPLACE_CLICK);
    await harness.settleUntil(async () =>
      await refusals(owner) > refusedBefore ||
      ((await owner.read(heldPath)) !== undefined &&
        (await owner.link(["ownSpaceHome", "profiles", 0, "inbox", "piece"]))
            .id === (await owner.link(heldPath)).id)
    );
    expect(await refusals(owner)).toBe(refusedBefore);

    const held = await owner.link(heldPath);
    expect(held.space).toBe(inbox.space);
    expect(held.id).not.toBe(inbox.id);
    expect(await ownerOffers(held)).toEqual([]);
    expect(before).toContain("before the own-space replacement");
    expect((await ownerOffers(inbox)).map((each) => each.title)).toEqual(
      before,
    );
    expect((await owner.link(["privateInbox", "piece"])).id).toBe(inbox.id);
    expect(await owner.read(refusalPath)).toBeUndefined();
  });

  it("replaces a refused inbox the owner can no longer read, and points the refused profile at Home's own", async () => {
    // The stranger's inbox grants the owner `READ` while a profile is pointed
    // at it, and then revokes it, so the host refuses the inbox for access.
    const reader = { reader: owner.identity.did() };
    await stranger.send("createUnreadableInbox", reader);
    await harness.settleUntil(async () =>
      (await owner.read(["unreadableInbox", "piece"])) !== undefined
    );
    const unreadable = await owner.link(["unreadableInbox", "piece"]);
    await owner.send("createUnreadableRefusedProfile");
    await harness.settle();
    await owner.send("pointUnreadableRefusedProfile", { index: 0 });
    const pointer = [
      "unreadableRefusedHome",
      "profiles",
      0,
      "inbox",
      "piece",
    ];
    await harness.settleUntil(async () =>
      await pointed(["unreadableRefusedHome", "profiles", 0])
    );
    expect((await owner.link(pointer)).id).toBe(unreadable.id);
    await stranger.send("revokeUnreadableInbox", reader, REPLACE_CLICK);
    await harness.settle();
    await expect(owner.read(["offers"], { piece: unreadable })).rejects
      .toThrow(/unauthorized|lacks READ/);

    expect(await ensureThroughHost(["unreadableRefusedHome"])).toMatchObject({
      outcome: "refused",
      reason: "inbox-access-refused",
    });
    const refusal = ["unreadableRefusedHome", "privateInboxRefusal", "refusal"];
    await harness.settleUntil(async () =>
      (await owner.read([...refusal, "reason"])) !== undefined
    );
    expect(await owner.read([...refusal, "reason"])).toBe(
      "inbox-access-refused",
    );

    // A runtime of the owner's started after the revocation sends the marked
    // replacement first, and the inbox is replaced: by the serving loop, or
    // with server execution off by that runtime's own commit. The replacement
    // record keeps a typed link to the refused inbox, which a runtime that
    // cannot read the inbox still commits, since a link write takes nothing
    // from the document it points at.
    const held = ["unreadableRefusedHome", "privateInbox", "piece"];
    const late = await harness.addSession({
      label: "private-inbox-owner-late",
      identity: owner.identity,
    });
    try {
      const lateRefusedBefore = await refusals(late);
      await late.send("replaceUnreadableRefusedInbox", {}, REPLACE_CLICK);
      await harness.settleUntil(async () =>
        await refusals(late) > lateRefusedBefore ||
        (await owner.read(held)) !== undefined
      );
      expect(await owner.read(held)).not.toBeUndefined();
      expect(await owner.read(refusal)).toBeUndefined();
    } finally {
      await harness.closeSession("private-inbox-owner-late");
    }

    const refusedBefore = await refusals(owner);
    await owner.send("replaceUnreadableRefusedInbox", {}, REPLACE_CLICK);
    await harness.settleUntil(async () =>
      await refusals(owner) > refusedBefore ||
      ((await owner.read(held)) !== undefined &&
        (await stranger.link(pointer)).id === (await owner.link(held)).id)
    );
    expect(await refusals(owner)).toBe(refusedBefore);
    expect((await stranger.link(pointer)).id).toBe(
      (await owner.link(held)).id,
    );
    expect(await owner.read(refusal)).toBeUndefined();
  });
});
