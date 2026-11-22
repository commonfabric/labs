/**
 * When a FabriChat manager drops a notice it holds: once the notice's
 * recipient is on the room's roster, the sender's next join of the room drops
 * it, and not before, an offer that adds them included; the sender's next act
 * drops a notice of a room the catalog says is deleted; and a join of a room
 * the sender holds no notice of reads no roster.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterAll, afterEach, beforeAll, describe, it } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";

import { createSession, Identity } from "@commonfabric/identity";
import { type Cell, Runtime, type URI } from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const sender = await Identity.fromPassphrase("FabriChat notice prune sender");
const recipient = await Identity.fromPassphrase(
  "FabriChat notice prune recipient",
);

const PATTERNS = fromFileUrl(new URL("../../../patterns/", import.meta.url));

/** What a request's outcome holds, as far as these tests read it. */
const outcomeSchema = {
  type: "object",
  properties: {
    status: { type: "string" },
    entry: {
      type: "object",
      properties: { room: { asCell: ["cell"] } },
    },
  },
} as const;

/** What the tests read of a stored notice. */
const noticesSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      recipient: { type: "string" },
      room: { type: "unknown", asCell: ["cell"] },
    },
  },
} as const;

/** What the tests read of a room's roster: how many profiles it lists. */
const rosterSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
} as const;

/** What the tests read of a storage transaction as it commits. */
interface CommittingTx {
  /** Whether it is an event's. */
  immediate?: boolean;

  /** The action it runs for, if any. */
  sourceAction?: unknown;

  /** The reads it has recorded. */
  getReadActivities(): Iterable<{ space: string; id: string }>;

  /** Commits it. */
  commit(...args: unknown[]): unknown;
}

/** `event` as the renderer delivers a click on `surface`'s `action`. */
const trusted = (
  event: Record<string, unknown>,
  surface: string,
  action: string,
): Record<string, unknown> => {
  const click = {
    type: "click",
    ...event,
    provenance: reviewedActionProvenance("dom", { surface, action }),
  };
  markRendererTrustedEvent(click);
  return click;
};

/** Sends `event` to `piece`'s `stream`, and waits for what it does. */
const send = async (
  runtime: Runtime,
  piece: Cell<unknown>,
  stream: readonly string[],
  event: Record<string, unknown>,
): Promise<void> => {
  const tx = runtime.edit();
  let target: Cell<unknown> = piece.withTx(tx);
  for (const key of stream) target = target.key(key);
  target.send(event);
  runtime.prepareTxForCommit(tx);
  expect((await tx.commit().settled).error).toBeUndefined();
  await runtime.idle();
};

/** A runtime of `identity`'s on `server`, with its Home brought up. */
const homeOf = async (
  server: ReturnType<typeof newLoopbackServer>,
  apiUrl: URL,
  identity: Identity,
  experimental?: { serverExecution: false },
) => {
  const storage = EmulatedStorageManager.connectTo(server, { as: identity });
  const runtime = new Runtime({
    apiUrl,
    storageManager: storage,
    ...(experimental === undefined ? {} : { experimental }),
  });
  const home = (await new PiecesController(
    createSession({ identity, spaceDid: identity.did() }),
    runtime,
  ).ensureDefaultPattern()).getCell();
  await runtime.idle();
  await home.pull();
  return { storage, runtime, home };
};

describe("fabrichat-notice-prune", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let http: Deno.HttpServer<Deno.NetAddr>;
  let apiUrl: URL;
  let senders: Awaited<ReturnType<typeof homeOf>>;
  let recipients: Awaited<ReturnType<typeof homeOf>>;

  beforeAll(async () => {
    server = newLoopbackServer();
    const route = new PatternsRoute(PATTERNS);
    http = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) =>
        await route.serve(request) ??
          new Response("Not found", { status: 404 }),
    );
    apiUrl = new URL(`http://127.0.0.1:${http.addr.port}`);
    senders = await homeOf(server, apiUrl, sender);
    recipients = await homeOf(server, apiUrl, recipient);
    for (
      const [{ runtime, home }, name] of [
        [senders, "Notice sender"],
        [recipients, "Notice recipient"],
      ] as const
    ) {
      await send(
        runtime,
        home,
        ["createProfile"],
        trusted(
          { target: { value: name } },
          "ProfileCreateSurface",
          "CreateProfile",
        ),
      );
    }
  });

  afterAll(async () => {
    for (const side of [recipients, senders]) {
      await side?.runtime.dispose();
      await side?.storage.close();
    }
    await server?.close();
    await http?.shutdown();
  });

  /** Creates a group of the sender's naming `members`, and returns its room. */
  const createGroup = async (
    requestId: string,
    members: readonly string[],
  ): Promise<Cell<unknown>> => {
    await send(
      senders.runtime,
      senders.home,
      ["chatManager", "createGroup"],
      trusted(
        { requestId, title: requestId, members },
        "ChatStartSurface",
        "ChatStart",
      ),
    );
    const outcome = await senders.home.key("chatManager").key("requests")
      .key(requestId).asSchema(outcomeSchema).pull() as {
        status?: string;
        entry?: { room?: Cell<unknown> };
      };
    expect(outcome?.status).toBe("done");
    return outcome!.entry!.room!;
  };

  /**
   * The recipients of the notices the sender's manager stores for `room`, as
   * the runtime `home` is in reads them.
   */
  const storedNoticesOf = async (
    room: Cell<unknown>,
    home: Cell<unknown> = senders.home,
  ): Promise<string[]> => {
    const stored = home.key("chatManager").resolveAsCell()
      .getArgumentCell<unknown>()!.key("outgoingNotices");
    const notices = await stored.asSchema(noticesSchema).pull() as {
      recipient?: string;
      room?: Cell<unknown>;
    }[];
    return (notices ?? []).filter((notice) => notice.room?.space === room.space)
      .map((notice) => notice.recipient ?? "");
  };

  /** Has the sender's manager join `room`, as each message they send does. */
  const senderJoins = (
    runtime: Runtime,
    home: Cell<unknown>,
    room: Cell<unknown>,
  ) =>
    send(runtime, home, ["chatManager", "joinRoom"], {
      room: runtime.getCellFromLink(room.getAsNormalizedFullLink()),
      messageAct: true,
    });

  it("keeps a notice whose recipient has not joined the room when the sender joins it", async () => {
    const room = await createGroup("unjoined", [recipient.did()]);
    expect(await storedNoticesOf(room)).toEqual([recipient.did()]);

    await senderJoins(senders.runtime, senders.home, room);

    expect(await storedNoticesOf(room)).toEqual([recipient.did()]);
  });

  it("drops a notice once its recipient has joined the room and the sender next joins it", async () => {
    const room = await createGroup("joined", [recipient.did()]);
    const roster = senders.runtime.getCellFromLink(
      room.getAsNormalizedFullLink(),
    ).key("roster").asSchema(rosterSchema);
    const before = (await roster.pull() ?? []).length;
    // The sender's runtime hears of the recipient's join from the server, in
    // its own time.
    const heard = Promise.withResolvers<void>();
    const cancel = roster.sink((members) => {
      if ((members ?? []).length > before) heard.resolve();
    });
    await send(
      recipients.runtime,
      recipients.home,
      ["chatManager", "joinRoom"],
      {
        requestId: "recipient-join",
        room: recipients.runtime.getCellFromLink(
          room.getAsNormalizedFullLink(),
        ),
      },
    );
    await heard.promise;
    cancel();
    await senders.runtime.idle();
    expect(await storedNoticesOf(room)).toEqual([recipient.did()]);

    await senderJoins(senders.runtime, senders.home, room);

    expect(await storedNoticesOf(room)).toEqual([]);
  });

  it("keeps a notice an offer adds its recipient for, until the sender next joins the room", async () => {
    // The offer adds the recipient to the room's participants by an event of
    // its own, which could fail, so the notice stays until the roster lists
    // them.

    const room = await createGroup("offered", [recipient.did()]);
    const profile = senders.runtime.getCellFromLink(
      recipients.home.key("profiles").key(0).resolveAsCell()
        .getAsNormalizedFullLink(),
    );

    await send(senders.runtime, senders.home, ["chatManager", "offerRoom"], {
      requestId: "offer-recipient",
      room: senders.runtime.getCellFromLink(room.getAsNormalizedFullLink()),
      profile,
    });

    expect(await storedNoticesOf(room)).toEqual([recipient.did()]);

    await senderJoins(senders.runtime, senders.home, room);

    expect(await storedNoticesOf(room)).toEqual([]);
  });

  describe("when the catalog says a room is deleted", () => {
    // The catalog's word is written as Home's `markDeleted` writes it, once
    // the memory server has said so: the entry moves to the `deleted` state.

    let doomed: Cell<unknown>;
    let live: Cell<unknown>;

    beforeAll(async () => {
      doomed = await createGroup("doomed", [recipient.did()]);
      live = await createGroup("live", [recipient.did()]);
      const tx = senders.runtime.edit();
      senders.home.withTx(tx).key("sharedSpaceCatalogStorage").key("entries")
        .key(doomed.space).key("state").set("deleted");
      expect((await tx.commit().settled).error).toBeUndefined();
      await senders.runtime.idle();
    });

    it("drops the room's notice at the sender's manager's next act, and not before", async () => {
      expect(await storedNoticesOf(doomed)).toEqual([recipient.did()]);

      await senderJoins(senders.runtime, senders.home, live);

      expect(await storedNoticesOf(doomed)).toEqual([]);
      expect(await storedNoticesOf(live)).toEqual([recipient.did()]);
    });

    it("opens no session in the room's space on a client listing the notices once the sender's manager has acted", async () => {
      await senderJoins(senders.runtime, senders.home, live);
      await senders.storage.synced();
      const client = await homeOf(server, apiUrl, sender, {
        serverExecution: false,
      });
      try {
        const listed = await client.home.key("chatManager")
          .key("outgoingNotices").asSchema(noticesSchema).pull() as {
            room?: Cell<unknown>;
          }[];
        await client.runtime.idle();

        expect(listed.some((notice) => notice.room?.space === live.space))
          .toBe(true);
        expect(client.storage.openedSpaces()).not.toContain(doomed.space);
      } finally {
        await client.runtime.dispose();
        await client.storage.close();
      }
    });
  });

  describe("on a client of the sender's that has not loaded the room", () => {
    // The client's handler reads the room's roster only where a notice of
    // the room waits.

    let client: Awaited<ReturnType<typeof homeOf>>;

    beforeAll(async () => {
      await senders.runtime.idle();
      await senders.storage.synced();
      client = await homeOf(server, apiUrl, sender, { serverExecution: false });
    });

    afterAll(async () => {
      await client?.runtime.dispose();
      await client?.storage.close();
    });

    /** The id of `room`'s roster document, as the sender's runtime links it. */
    const rosterIdOf = (room: Cell<unknown>): URI =>
      senders.runtime.getCellFromLink(room.getAsNormalizedFullLink())
        .key("roster").resolveAsCell().getAsNormalizedFullLink().id as URI;

    /**
     * Whether a handler's transaction on the client read `room`'s roster
     * document while the client handled the sender's join of `room`, by the
     * reads each event transaction holds as it commits.
     */
    const joinReadsRoster = async (room: Cell<unknown>): Promise<boolean> => {
      const roster = rosterIdOf(room);
      const probe = client.runtime.edit();
      const prototype = Object.getPrototypeOf(probe.tx) as CommittingTx;
      probe.abort();
      // A transaction lets go of its reads once it commits, so they are
      // taken as the commit starts.
      const read: string[][] = [];
      const spy: Stub<CommittingTx> = stub(
        prototype,
        "commit",
        function (this: CommittingTx, ...args: unknown[]): unknown {
          if (this.immediate === true && this.sourceAction !== undefined) {
            read.push(
              [...this.getReadActivities()].filter((r) =>
                r.space === room.space
              ).map((r) => r.id),
            );
          }
          return spy.original.apply(this, args);
        },
      );
      try {
        await senderJoins(client.runtime, client.home, room);
      } finally {
        spy.restore();
      }
      return read.some((ids) => ids.includes(roster));
    };

    it("reads the roster of a room it holds a notice of when the sender joins it", async () => {
      const room = await createGroup("noticed", [recipient.did()]);
      await senders.storage.synced();
      // The client hears of the notice from the server, in its own time.
      const stored = client.home.key("chatManager").resolveAsCell()
        .getArgumentCell<unknown>()!.key("outgoingNotices")
        .asSchema(noticesSchema);
      const heard = Promise.withResolvers<void>();
      const cancel = stored.sink((notices) => {
        if (
          (notices ?? []).some((notice) => notice.room?.space === room.space)
        ) heard.resolve();
      });
      await heard.promise;
      cancel();

      expect(await joinReadsRoster(room)).toBe(true);
    });

    it("reads no roster of a room it holds no notice of when the sender joins it", async () => {
      const room = await createGroup("plain", []);
      await senders.storage.synced();

      expect(await joinReadsRoster(room)).toBe(false);
    });
  });

  describe("on a client of the sender's that has run nothing of the room since its recipient joined", () => {
    // The recipient's join adds them to the room's roster, and no runtime
    // derives anything of the room after it, so the client reads the roster
    // as the room stores it.

    let client: Awaited<ReturnType<typeof homeOf>> | undefined;

    afterEach(async () => {
      await client?.runtime.dispose();
      await client?.storage.close();
      client = undefined;
    });

    /** Has the recipient's manager join `room`, as accepting its offer does. */
    const recipientJoins = async (
      requestId: string,
      room: Cell<unknown>,
    ): Promise<void> => {
      await send(
        recipients.runtime,
        recipients.home,
        ["chatManager", "joinRoom"],
        {
          requestId,
          room: recipients.runtime.getCellFromLink(
            room.getAsNormalizedFullLink(),
          ),
        },
      );
      await recipients.storage.synced();
      await senders.runtime.idle();
      await senders.storage.synced();
    };

    /** A new client of the sender's, which has loaded none of the room. */
    const newClient = async () => {
      client = await homeOf(server, apiUrl, sender, { serverExecution: false });
      return client;
    };

    /** The ids of the profiles `room` lists on its roster, as `runtime` reads it. */
    const rosterOf = async (
      runtime: Runtime,
      room: Cell<unknown>,
    ): Promise<string[]> => {
      const roster = await runtime.getCellFromLink(
        room.getAsNormalizedFullLink(),
      ).key("roster").asSchema(rosterSchema).pull() as Cell<unknown>[];
      return (roster ?? []).map((profile) =>
        profile.getAsNormalizedFullLink().id
      );
    };

    /** The id of the first profile `home` lists. */
    const profileIdOf = (home: Cell<unknown>): string =>
      home.key("profiles").key(0).resolveAsCell().getAsNormalizedFullLink().id;

    it("reads the recipient on the room's roster", async () => {
      const room = await createGroup("read-after-join", [recipient.did()]);
      await recipientJoins("read-after-join-accept", room);
      const { runtime } = await newClient();

      expect(await rosterOf(runtime, room)).toEqual([
        profileIdOf(senders.home),
        profileIdOf(recipients.home),
      ]);
    });

    it("drops the notice when the sender joins the room", async () => {
      const room = await createGroup("joined-unread", [recipient.did()]);
      await recipientJoins("joined-unread-accept", room);
      const { runtime, home } = await newClient();
      expect(await storedNoticesOf(room, home)).toEqual([recipient.did()]);

      await senderJoins(runtime, home, room);

      expect(await storedNoticesOf(room, home)).toEqual([]);
    });

    it("drops the notice of a direct room, and offers it nothing, when the sender starts the chat again", async () => {
      // A start naming the recipient by principal alone creates the room and
      // queues a notice for them; a start naming their profile finds the
      // room again, and re-offers it.

      const first = "direct-unread";
      await send(
        senders.runtime,
        senders.home,
        ["chatManager", "openDirect"],
        trusted(
          { requestId: first, counterpart: recipient.did() },
          "ChatStartSurface",
          "ChatStart",
        ),
      );
      const outcome = await senders.home.key("chatManager").key("requests")
        .key(first).asSchema(outcomeSchema).pull() as {
          status?: string;
          entry?: { room?: Cell<unknown> };
        };
      expect(outcome?.status).toBe("done");
      const room = outcome!.entry!.room!;
      await senders.runtime.idle();
      expect(await storedNoticesOf(room)).toEqual([recipient.did()]);
      await recipientJoins("direct-unread-accept", room);
      const { runtime, home } = await newClient();
      expect(await storedNoticesOf(room, home)).toEqual([recipient.did()]);

      await send(
        runtime,
        home,
        ["chatManager", "openDirect"],
        trusted(
          {
            requestId: "direct-unread-again",
            counterpart: recipient.did(),
            profile: runtime.getCellFromLink(
              recipients.home.key("profiles").key(0).resolveAsCell()
                .getAsNormalizedFullLink(),
            ),
          },
          "ChatStartSurface",
          "ChatStart",
        ),
      );

      expect(await storedNoticesOf(room, home)).toEqual([]);
    });
  });
});
