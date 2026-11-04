/**
 * What a FabriChat manager does over a shared-space catalog that carries its
 * owner's `PersonalSpace` label, under either server-execution posture. Ada's
 * Home stand-in lives in her home space, whose catalog has taken in an offer
 * from her labeled share inbox. An offer to Grace, and a direct room offered to
 * her again, each reach Grace's own inbox, a space that admits no such label.
 * Groups created in a row are each done, saved in the catalog and listed in
 * `rooms`, and so they are after a retitle carries the label onto one entry's
 * title alone.
 *
 * Under server execution, a served act that sends an event joins what it read
 * to that event's bookkeeping and writes it in the sender's own space; with it
 * off, each session's own runtime runs the handlers, and the same acts are the
 * control.
 *
 * Both stand-ins share the harness's one space, Ada's home, so the server runs
 * with no access list: a home space grants no one but its owner.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  resolveServerExecution,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrichat-stamped-catalog",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

/** Whether this run's harness serves handlers from a serving loop. */
const SERVER_EXECUTION = resolveServerExecution();

/** Ada's session, whose DID the fixture's label names. */
const ADA = "fabrichat-stamped-catalog-ada";

/** Grace's session. */
const GRACE = "fabrichat-stamped-catalog-grace";

// The reviewed action a start is admitted from, as
// `../system/fabrichat/schemas.tsx` names it.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };

// Stand-ins for another principal, and for a space it offers.
const CY = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const OFFERED_SPACE =
  "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp";

// How a client that demands the fields as a plain array reads `rooms`.
const ROOMS_DEMAND = {
  type: "array",
  items: { type: "object", properties: { kind: { type: "string" } } },
} as const;

/** The address of a cell, as `MultiRuntimeSession.link()` returns one. */
type CellAddress = Awaited<ReturnType<MultiRuntimeSession["link"]>>;

/** A link to `address`, as an event carries one. */
const linkTo = (address: CellAddress) => ({
  "/": {
    "link@1": { id: address.id, path: address.path, space: address.space },
  },
});

describe("fabrichat labeled catalog across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let ada: MultiRuntimeSession;
  let grace: MultiRuntimeSession;
  let graceProfile: CellAddress;
  let graceInbox: CellAddress;

  /** Whether Grace's inbox holds an offer whose id is `id`. */
  const graceHolds = async (id: string): Promise<boolean> =>
    ((await grace.read(["offers"], { piece: graceInbox })) as
      | { id: string }[]
      | undefined ?? []).some((offer) => offer.id === id);

  /**
   * The paths of the catalog document's label entries that name Ada's
   * `PersonalSpace`, each joined with `/`.
   */
  const labeledCatalogPaths = async (): Promise<string[]> => {
    const catalog = await ada.link(["sharedSpaceCatalog"]);
    const stored = (await ada.rawRead(catalog)).value as unknown as {
      cfc?: {
        labelMap?: {
          entries?: {
            path: string[];
            label: {
              confidentiality?: { type?: string; owner?: string }[];
            };
          }[];
        };
      };
    };
    const { type, owner } = cfcAtom.personalSpace(ada.identity.did());
    return (stored.cfc?.labelMap?.entries ?? [])
      .filter((entry) =>
        (entry.label.confidentiality ?? []).some((clause) =>
          clause.type === type && clause.owner === owner
        )
      )
      .map((entry) => entry.path.join("/"));
  };

  /** Creates a group, and waits until the catalog saves it. */
  const createGroup = async (
    requestId: string,
    title: string,
  ): Promise<CellAddress> => {
    await ada.send("createGroup", {
      requestId,
      title,
      members: [],
    }, START_ACTION);
    await harness.settle();
    expect(await ada.read(["requests", requestId, "status"])).toBe("done");
    const room = await ada.link(["requests", requestId, "entry", "room"]);
    await harness.settleUntil(async () =>
      (await ada.read([
        "sharedSpaceCatalog",
        "entries",
        room.space,
        "state",
      ])) === "saved"
    );
    expect(
      await ada.read(["sharedSpaceCatalog", "entries", room.space, "title"]),
    ).toBe(title);
    return room;
  };

  /** Waits until `rooms` lists `count` groups, and nothing else. */
  const expectGroupsListed = async (count: number): Promise<void> => {
    const listed = async () =>
      ((await ada.readAs(["rooms"], ROOMS_DEMAND)) as
        | { kind?: string }[]
        | undefined ?? []).map((entry) => entry.kind);
    await harness.settleUntil(async () => (await listed()).length >= count);
    expect(await listed()).toEqual(Array(count).fill("group"));
  };

  beforeEach(async () => {
    // Ada's stand-in lives in her home space, where a Home does.
    const home =
      (await Identity.fromPassphrase(`multi-runtime-harness ${ADA}`, {
        implementation: "noble",
      })).did();
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [ADA, GRACE],
      spaceDid: home,
    });
    [ada, grace] = harness.sessions;

    // Grace's stand-in is a piece of her own, which becomes her session's.
    await grace.client().call("createPiece", {
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
    });
    await grace.send("createProfile", { name: "Grace" });
    await harness.settle();
    await grace.client().call("ensurePrivateInbox", { path: [] });
    await harness.settleUntil(async () =>
      (await grace.read(["profiles", 0, "inbox", "piece"])) !== undefined
    );
    graceProfile = await grace.link(["profiles", 0]);
    graceInbox = await grace.link(["privateInbox", "piece"]);

    // Ada's catalog takes in an offer from her labeled share inbox.
    await ada.send("createProfile", { name: "Ada" });
    await harness.settle();
    await ada.send("receive", {
      offer: {
        from: CY,
        id: "offer-1",
        space: OFFERED_SPACE,
        host: "https://example.com",
      },
    });
    await harness.settle();

    // Under server execution a fired event travels as an append for the serving
    // loop, and otherwise as none.
    const admitted = await harness.admittedCommitsDuring(async () => {
      await ada.send("ingest", {});
      await harness.settle();
    });
    expect(
      admitted.some((commit) => (commit.eventAppends?.length ?? 0) > 0),
    ).toBe(SERVER_EXECUTION);
    expect(
      await ada.read(["sharedSpaceCatalog", "entries", OFFERED_SPACE, "kind"]),
    ).toBe("workspace");
    expect(await labeledCatalogPaths()).not.toEqual([]);
  });

  afterEach(async () => {
    await harness?.dispose();
  });

  it("offers a group to a member added to it, through their profile's inbox", async () => {
    const group = await createGroup("g-team", "Team");
    await ada.send("offerRoom", {
      requestId: "add-grace",
      room: linkTo(group),
      profile: linkTo(graceProfile),
    });
    await harness.settle();
    expect(await ada.read(["requests", "add-grace"])).toEqual({
      status: "done",
      delivery: "offered",
    });
    await harness.settleUntil(() => graceHolds("add-grace"));
  });

  it("offers a direct room found again to its counterpart, through their profile's inbox", async () => {
    // A start naming Grace by principal alone creates the room and queues a
    // notice for her, which the serving loop runs on its own account, so
    // `settle()` does not wait for it.
    await ada.send("openDirect", {
      requestId: "d-first",
      counterpart: grace.identity.did(),
    }, START_ACTION);
    await harness.settle();
    expect(await ada.read(["requests", "d-first", "status"])).toBe("done");
    await harness.settleUntil(async () =>
      (await ada.read(["outgoingNotices", "length"])) === 1
    );

    await ada.send("openDirect", {
      requestId: "d-again",
      counterpart: grace.identity.did(),
      profile: linkTo(graceProfile),
    }, START_ACTION);
    await harness.settle();
    expect(await ada.read(["requests", "d-again", "status"])).toBe("done");
    await harness.settleUntil(() => graceHolds("d-again"));
  });

  it("lists two groups created in a row", async () => {
    await createGroup("g-1", "One");
    await expectGroupsListed(1);
    await createGroup("g-2", "Two");
    await expectGroupsListed(2);
  });

  it("lists each group created after a retitle carries the label onto an entry's title", async () => {
    const old = await createGroup("g-old", "Old");
    await ada.send("receive", {
      offer: {
        from: CY,
        id: "offer-retitle",
        space: old.space,
        host: "https://example.com",
        title: "Old, retitled",
      },
    });
    await harness.settle();
    await ada.send("retitle", {});
    await harness.settle();
    expect(
      await ada.read(["sharedSpaceCatalog", "entries", old.space, "title"]),
    ).toBe("Old, retitled");
    expect(await labeledCatalogPaths()).toContain(
      `entries/${old.space}/title`,
    );
    await expectGroupsListed(1);

    await createGroup("g-2", "Two");
    await expectGroupsListed(2);
    await createGroup("g-3", "Three");
    await expectGroupsListed(3);
  });
});
