/**
 * What a change to the user's catalog makes a client's FabriChat manager read
 * while it lists its notices: deciding the notices reads their rooms, and
 * depends on nothing but the notices and those rooms, so a room's adoption or
 * a join, which write the catalog, run no reader of a notice's room.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import { adoptCatalogRoomsOf } from "../src/ops/adopt-catalog-rooms.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const owner = await Identity.fromPassphrase("FabriChat notice reads owner");
const recipient = (await Identity.fromPassphrase(
  "FabriChat notice reads recipient",
)).did();

const PATTERNS = fromFileUrl(new URL("../../../patterns/", import.meta.url));

/** How many listed rooms the owner has, each with a notice to `recipient`. */
const LISTED = 3;

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

/** The Home of `owner` on `runtime`, brought up. */
const bringUpHome = async (runtime: Runtime): Promise<Cell<unknown>> => {
  const home = (await new PiecesController(
    createSession({ identity: owner, spaceDid: owner.did() }),
    runtime,
  ).ensureDefaultPattern()).getCell();
  await runtime.idle();
  await home.pull();
  return home;
};

describe("fabrichat-notice-reads", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let http: Deno.HttpServer<Deno.NetAddr>;
  let apiUrl: URL;
  let writerStorage: EmulatedStorageManager;
  let writer: Runtime;

  /** The listed rooms, each the subject of a notice. */
  const listed: Cell<unknown>[] = [];

  /** A listed room with no notice, which a join writes the catalog for. */
  let plain: Cell<unknown>;

  /**
   * Creates a group naming `members` by principal, and returns its room: one
   * that names `recipient` is the subject of a notice to them.
   */
  const createGroup = async (
    home: Cell<unknown>,
    requestId: string,
    members: readonly string[] = [recipient],
  ): Promise<Cell<unknown>> => {
    await send(
      writer,
      home,
      ["chatManager", "createGroup"],
      trusted(
        { requestId, title: requestId, members },
        "ChatStartSurface",
        "ChatStart",
      ),
    );
    const outcome = await home.key("chatManager").key("requests").key(
      requestId,
    ).asSchema(outcomeSchema).pull() as {
      status?: string;
      entry?: { room?: Cell<unknown> };
    };
    expect(outcome?.status).toBe("done");
    return outcome!.entry!.room!;
  };

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
    writerStorage = EmulatedStorageManager.connectTo(server, { as: owner });
    writer = new Runtime({ apiUrl, storageManager: writerStorage });
    const home = await bringUpHome(writer);
    await send(
      writer,
      home,
      ["createProfile"],
      trusted(
        { target: { value: "Notice owner" } },
        "ProfileCreateSurface",
        "CreateProfile",
      ),
    );
    for (let i = 0; i < LISTED; i++) {
      listed.push(await createGroup(home, `listed-${i}`));
    }
    plain = await createGroup(home, "plain", []);
    // The last room, with no notice, is the one adoption joins.
    await createGroup(home, "unadopted", []);

    // The catalog keeps listing the last room, and the manager no longer
    // holds its membership, as when a room reaches the catalog before the
    // manager records it.
    const memberships = home.key("chatManager").key("roomMembership")
      .resolveAsCell();
    const stored = memberships.getRaw() as unknown[];
    const tx = writer.edit();
    memberships.withTx(tx).setRaw(stored.slice(0, -1));
    expect((await tx.commit().settled).error).toBeUndefined();
    await writer.idle();
    await writerStorage.synced();
  });

  afterAll(async () => {
    await writer?.dispose();
    await writerStorage?.close();
    await server?.close();
    await http?.shutdown();
  });

  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  let home: Cell<unknown>;
  let cancelNotices: () => void;

  /** The cells through which the client keeps each notice's room loaded. */
  let rosters: Cell<unknown>[];

  beforeEach(async () => {
    // A client that has each notice's room loaded and lists the notices, as
    // a host that delivers them does.
    storage = EmulatedStorageManager.connectTo(server, { as: owner });
    runtime = new Runtime({
      apiUrl,
      storageManager: storage,
      experimental: { serverExecution: false },
    });
    home = await bringUpHome(runtime);
    rosters = listed.map((room) =>
      runtime.getCellFromLink(room.getAsNormalizedFullLink()).key("roster")
    );
    for (const roster of rosters) await roster.pull();
    cancelNotices = home.key("chatManager").key("outgoingNotices").sink(
      () => {},
    );
    await runtime.idle();
    await storage.synced();
    // A pull settles what the subscription left to run, so a case measures
    // only what its own act runs.
    await home.key("chatManager").key("outgoingNotices").pull();
    await runtime.idle();
    await storage.synced();
  });

  afterEach(async () => {
    cancelNotices?.();
    await runtime?.dispose();
    await storage?.close();
  });

  /**
   * How many times two sets of actions have run on the client, by the
   * scheduler's own record of each action's reads and writes: `readers`, the
   * actions that read the rooms of several notices (a room's own actions read
   * that room alone, so they are not counted), and `filter`, the action that
   * writes the notices the manager lists.
   */
  const runs = (): { readers: number; filter: number } => {
    const spaces = listed.map((room) => `${room.space}/`);
    const listedLink = home.key("chatManager").key("outgoingNotices")
      .resolveAsCell().getAsNormalizedFullLink();
    const listing = `${listedLink.space}/${listedLink.id}/`;
    const count = (nodes: { stats?: { runCount: number } }[]) =>
      nodes.reduce((sum, node) => sum + (node.stats?.runCount ?? 0), 0);
    const nodes = runtime.scheduler.getGraphSnapshot().nodes;
    return {
      readers: count(
        nodes.filter((node) =>
          spaces.filter((space) =>
            (node.reads ?? []).some((read) => read.startsWith(space))
          ).length > 1
        ),
      ),
      filter: count(
        nodes.filter((node) =>
          (node.writes ?? []).some((write) => write.startsWith(listing))
        ),
      ),
    };
  };

  /** How many notices the client's manager lists. */
  const listedNotices = async (): Promise<number> => {
    const notices = await home.key("chatManager").key("outgoingNotices")
      .asSchema({ type: "array", items: { type: "object" } } as const)
      .pull();
    return notices?.length ?? 0;
  };

  it("runs a reader of the notices' rooms, and the filter, as it lists them", () => {
    expect(runs().readers).toBeGreaterThan(0);
    expect(runs().filter).toBeGreaterThan(0);
  });

  it("runs no reader of a notice's room when adoption lists a room", async () => {
    const before = runs().readers;

    const stopped = await adoptCatalogRoomsOf(runtime, home, owner.did());
    await runtime.idle();
    await storage.synced();

    expect(stopped).toBe(1);
    expect(runs().readers).toBe(before);
    expect(await listedNotices()).toBe(LISTED);
  });

  it("runs the filter once and no reader of a notice's room when a new group is listed", async () => {
    const before = runs();
    const catalogBefore = JSON.stringify(
      await home.key("chatManager").key("sharedSpaceCatalog").pull(),
    );

    await send(
      runtime,
      home,
      ["chatManager", "createGroup"],
      trusted(
        { requestId: "new-group", title: "New group", members: [] },
        "ChatStartSurface",
        "ChatStart",
      ),
    );
    await storage.synced();

    const catalogAfter = JSON.stringify(
      await home.key("chatManager").key("sharedSpaceCatalog").pull(),
    );
    expect(catalogAfter).not.toBe(catalogBefore);
    const after = runs();
    expect(after.filter - before.filter).toBe(1);
    expect(after.readers - before.readers).toBe(0);
  });

  it("runs no reader of a notice's room when a message act joins a listed room", async () => {
    const before = runs().readers;

    await send(runtime, home, ["chatManager", "joinRoom"], {
      requestId: "message-act",
      room: runtime.getCellFromLink(plain.getAsNormalizedFullLink()),
      messageAct: true,
    });
    await storage.synced();

    const outcome = await home.key("chatManager").key("requests").key(
      "message-act",
    ).asSchema(outcomeSchema).pull() as { status?: string };
    expect(outcome?.status).toBe("done");
    expect(runs().readers).toBe(before);
    expect(await listedNotices()).toBe(LISTED);
  });
});
