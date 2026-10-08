/**
 * The multi-runtime harness driving the host's share intake: the owner's host
 * follows the private inbox of a Home stand-in, and a second identity creates
 * a space of its own, declaring its kind, grants the owner, and offers it
 * through the inbox the owner's profile points at. The intake vets each offer
 * as the owner and registers it in the stand-in's shared-space catalog,
 * through Home's own catalog handlers, while the owner's worker runs. It
 * refuses an offer of a space declaring another kind or none, or whose root is
 * not where the space's genesis reserves it, and a forged row a third identity
 * appends directly. It registers an offer of a room the real FabriChat manager
 * created, whose space declares its kind and is rooted at the room.
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
  "share-intake",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

// The reviewed action a FabriChat start is admitted from, as
// `../fabrichat/schemas.tsx` names it.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };

/** A catalog entry, as the owner reads it. */
type Entry = {
  space: string;
  host: string;
  kind: string;
  state: string;
  revision: string;
  title?: string;
  from?: string;
  since?: number;
};

/** The owner's catalog, as the owner reads it. */
type Catalog = {
  entries: Record<string, Entry>;
  offers: Record<string, { space: string; kind: string; host: string }>;
};

describe("share intake across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let owner: MultiRuntimeSession;
  let sender: MultiRuntimeSession;
  let stranger: MultiRuntimeSession;
  let inbox: PieceAddress;
  let first: string;

  /** The owner's catalog, or `undefined` while it cannot be read. */
  const catalog = async (): Promise<Catalog | undefined> =>
    (await owner.read(["sharedSpaceCatalog"])) as Catalog | undefined;

  /** The receipt key of an offer from `from`, keyed `id`. */
  const receiptKey = (from: MultiRuntimeSession, id: string): string =>
    JSON.stringify([from.identity.did(), id]);

  /** The space the sender created and offered under `id`, once it has. */
  const offeredSpace = async (id: string): Promise<string | undefined> =>
    ((await sender.read(["offered"])) as { id: string; space: string }[] ?? [])
      .find((each) => each.id === id)?.space;

  /** What the owner's host last decided about rows from `from`, keyed `id`. */
  const decisions = async (
    from: MultiRuntimeSession,
    id: string,
  ): Promise<string[]> =>
    ((await owner.client().call("shareIntakeDecisions", {
      from: from.identity.did(),
      id,
    })) as { decisions: string[] }).decisions;

  /** Whether the owner's inbox holds an offer from `from`, keyed `id`. */
  const delivered = async (
    from: MultiRuntimeSession,
    id: string,
  ): Promise<boolean> =>
    ((await owner.read(["offers"], { piece: inbox })) as {
      id: string;
      from: string;
    }[] ?? []).some((each) =>
      each.id === id && each.from === from.identity.did()
    );

  /** How many offers the owner's host has refused. */
  const refusalsLogged = async (): Promise<number> => {
    const counts = (await owner.loggerCounts())["piece.share-intake"];
    return typeof counts === "object" ? counts["offer-refused"]?.total ?? 0 : 0;
  };

  /**
   * Has the sender create a space and offer it under `id`, and waits for the
   * owner's catalog to hold the offer's receipt. Returns the space.
   */
  const createAndOffer = async (id: string): Promise<string> => {
    await sender.send("createAndOffer", {
      id,
      title: `Room ${id}`,
      recipient: owner.identity.did(),
    });
    await harness.settleUntil(async () =>
      (await catalog())?.offers[receiptKey(sender, id)] !== undefined
    );
    const space = await offeredSpace(id);
    if (space === undefined) throw new Error(`No space offered as ${id}`);
    return space;
  };

  /**
   * Has the sender create a space as `request` says and offer it under `id`,
   * and returns what the owner's host decided about the offer once an offer
   * after it is registered, and how many refusals it logged meanwhile.
   */
  const createAndRefuse = async (
    id: string,
    request: { root?: boolean; spaceKind?: string | null },
  ): Promise<{ decisions: string[]; logged: number; received: boolean }> => {
    const before = await refusalsLogged();
    await sender.send("createAndOffer", {
      id,
      title: `Room ${id}`,
      recipient: owner.identity.did(),
      ...request,
    });
    await harness.settleUntil(async () => await delivered(sender, id));

    // The intake decides an inbox's offers in order, so this offer was
    // decided by the time an offer after it is registered.
    await createAndOffer(`after ${id}`);

    return {
      decisions: await decisions(sender, id),
      logged: await refusalsLogged() - before,
      received: (await catalog())?.offers[receiptKey(sender, id)] !==
        undefined,
    };
  };

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        "share-intake-owner",
        "share-intake-sender",
        "share-intake-stranger",
      ],
      aclMode: "enforce",
    });
    [owner, sender, stranger] = harness.sessions;

    await owner.send("createProfile");
    await harness.settle();
    await owner.client().call("ensurePrivateInbox", { path: [] });
    await harness.settleUntil(async () =>
      (await owner.read(["profiles", 0, "inbox", "piece"])) !== undefined
    );
    inbox = await owner.link(["privateInbox", "piece"]);
    expect(await owner.client().call("startShareIntake", { path: [] }))
      .toEqual({ started: true });

    first = await createAndOffer("first");
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("registers a space a second identity owns and offers, with the offer's sender, kind, host and title", async () => {
    const entry = (await catalog())?.entries[first];

    expect(entry?.state).toBe("saved");
    expect(entry?.kind).toBe("fabrichat-room");
    expect(entry?.from).toBe(sender.identity.did());
    expect(entry?.title).toBe("Room first");
    expect(entry?.host).toBe(new URL(entry?.host ?? "").origin);
    expect(typeof entry?.since).toBe("number");
    expect((await catalog())?.offers[receiptKey(sender, "first")]).toEqual({
      from: sender.identity.did(),
      id: "first",
      space: first,
      host: entry?.host,
      kind: "fabrichat-room",
    });
  });

  it("registers an offer of a room the FabriChat manager created", async () => {
    await sender.send("createChatGroup", {
      requestId: "chat",
      title: "Real room",
      members: [owner.identity.did()],
    }, START_ACTION);
    await harness.settle();
    expect(await sender.read(["chatRequests", "chat", "status"])).toBe("done");
    const room = await sender.link(["chatRequests", "chat", "entry", "room"]);
    await sender.send("offerAgain", {
      id: "real room",
      space: room.space,
      title: "Real room",
    });
    await harness.settleUntil(async () => await delivered(sender, "real room"));

    // The intake decides an inbox's offers in order, so this offer was
    // decided by the time an offer after it is registered.
    await createAndOffer("after the real room");

    expect((await catalog())?.offers[receiptKey(sender, "real room")]?.space)
      .toBe(room.space);
    expect((await catalog())?.entries[room.space]?.state).toBe("saved");
  });

  it("registers an offer arriving while the owner's worker runs, without a restart", async () => {
    const later = await createAndOffer("later");

    expect((await catalog())?.entries[later]?.from).toBe(
      sender.identity.did(),
    );
    expect(later).not.toBe(first);
  });

  it("refuses a forged row naming a sender with no entry in the space's access list, and logs it", async () => {
    const before = await refusalsLogged();
    const host = (await catalog())?.entries[first]?.host;
    // Read first, so the append below extends the offers as stored.
    await stranger.read(["offers"], { piece: inbox });
    const forged = await stranger.push(["offers"], {
      kind: "fabrichat-room",
      id: "forged",
      space: first,
      host,
      ownerOrigin: host,
      title: "Forged",
      from: stranger.identity.did(),
      sharedAt: Date.now(),
      receivedAt: Date.now(),
    }, { piece: inbox });
    expect(forged.ok).toBe(true);

    // The intake decides an inbox's offers in order, so the forged row was
    // decided by the time an offer after it is registered.
    await createAndOffer("after the forged row");

    expect((await catalog())?.offers[receiptKey(stranger, "forged")])
      .toBeUndefined();
    expect(await decisions(stranger, "forged")).toEqual(["sender-not-member"]);
    expect(await refusalsLogged()).toBe(before + 1);
  });

  it("refuses an offer of a room that is not its space's root, and logs it", async () => {
    expect(await createAndRefuse("unrooted", { root: false })).toEqual({
      decisions: ["space-root-missing"],
      logged: 1,
      received: false,
    });
  });

  it("refuses an offer of a room whose space declares another kind, and logs it", async () => {
    expect(await createAndRefuse("album", { spaceKind: "photo-album" }))
      .toEqual({
        decisions: ["space-kind-mismatch"],
        logged: 1,
        received: false,
      });
  });

  it("refuses an offer of a room whose space declares no kind, and logs it", async () => {
    expect(await createAndRefuse("unkinded", { spaceKind: null })).toEqual({
      decisions: ["space-kind-undeclared"],
      logged: 1,
      received: false,
    });
  });

  it("refuses an offer of a space whose root a member has linked away from the reserved address, and logs it", async () => {
    const space = await createAndOffer("to repoint");
    await sender.client().call("repointSpaceRoot", { space });
    const before = await refusalsLogged();
    await sender.send("offerAgain", {
      id: "repointed",
      space,
      title: "Repointed",
    });
    await harness.settleUntil(async () => await delivered(sender, "repointed"));

    // The intake decides an inbox's offers in order, so the repointed offer
    // was decided by the time an offer after it is registered.
    await createAndOffer("after the repointed root");

    expect((await catalog())?.offers[receiptKey(sender, "repointed")])
      .toBeUndefined();
    expect(await decisions(sender, "repointed")).toEqual([
      "space-root-misplaced",
    ]);
    expect(await refusalsLogged()).toBe(before + 1);
  });

  it("keeps an archived entry archived when the same space is offered again, recording the new offer's receipt", async () => {
    const space = await createAndOffer("to archive");
    const revision = (await catalog())?.entries[space]?.revision;
    await owner.send("changeSharedSpaceMembership", {
      space,
      id: "archive",
      expectedRevision: revision,
      state: "archived",
    });
    await harness.settleUntil(async () =>
      (await catalog())?.entries[space]?.state === "archived"
    );
    const archived = (await catalog())?.entries[space]?.revision;

    await sender.send("offerAgain", {
      id: "offered again",
      space,
      title: "Offered again",
    });
    await harness.settleUntil(async () =>
      (await catalog())?.offers[receiptKey(sender, "offered again")] !==
        undefined
    );

    const entry = (await catalog())?.entries[space];
    expect(entry?.state).toBe("archived");
    expect(entry?.revision).toBe(archived);
    expect(entry?.title).toBe("Room to archive");
  });
});
