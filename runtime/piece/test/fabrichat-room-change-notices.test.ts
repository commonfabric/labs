/**
 * What a client's share intake reads of the person's FabriChat rooms for the
 * notices that rooms changed which their share inbox holds, with the real
 * Home and chat manager: it reads the room of each notice the catalog does
 * not mark acted on, has the manager bring the catalog's title for it up to
 * the room's own, and reads no document of the space of a room whose notice
 * the catalog marks, so a client that starts after the notices were acted on
 * reads no room at all. Acting on a notice leaves no piece of the room's
 * space running.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import { createSession, Identity } from "@commonfabric/identity";
import { type Cell, type MemorySpace, Runtime } from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import {
  afterAll,
  beforeAll,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { startShareIntakeOf } from "../src/ops/share-intake.ts";

const owner = await Identity.fromPassphrase("FabriChat room notices owner");
const sender = (await Identity.fromPassphrase(
  "FabriChat room notices sender",
)).did();

const PATTERNS = fromFileUrl(new URL("../../../patterns/", import.meta.url));

/** How many of the owner's rooms each have a notice the catalog marks. */
const MARKED = 2;

/** How many of the owner's rooms each have a notice the catalog does not. */
const UNMARKED = 2;

/** When the sender shared every notice. */
const SHARED_AT = 1_700_000_001_000;

/** The title the catalog lists every room under, unlike the room's own. */
const STALE = "Stale";

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

/** What these tests read of the catalog. */
const catalogSchema = {
  type: "object",
  properties: {
    entries: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { title: { type: "string" } },
      },
    },
    notices: { type: "object", additionalProperties: { type: "number" } },
  },
} as const;

/** A private inbox, its offers read as they are stored. */
const inboxSchema = {
  type: "object",
  properties: {
    offers: {
      type: "array",
      items: { type: "object", additionalProperties: true },
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

/** The catalog's key for the sender's notice that the room in `space` changed. */
const noticeKey = (space: string): string =>
  JSON.stringify([sender, `changed:${space}`]);

describe("fabrichat-room-change-notices", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let http: Deno.HttpServer<Deno.NetAddr>;
  let apiUrl: URL;
  let writerStorage: EmulatedStorageManager;
  let writer: Runtime;

  /** The spaces of the rooms whose notices the catalog marks. */
  const marked: MemorySpace[] = [];

  /** The spaces of the rooms whose notices the catalog does not mark. */
  const unmarked: MemorySpace[] = [];

  /** The rooms' own titles, by space. */
  const titles = new Map<string, string>();

  /**
   * Has the owner's manager create a group titled `title`, with the sender
   * as a member, whom the room's space grants `OWNER`, and returns its space.
   */
  const createGroup = async (
    home: Cell<unknown>,
    title: string,
  ): Promise<MemorySpace> => {
    await send(
      writer,
      home,
      ["chatManager", "createGroup"],
      trusted(
        { requestId: title, title, members: [sender] },
        "ChatStartSurface",
        "ChatStart",
      ),
    );
    const outcome = await home.key("chatManager").key("requests").key(title)
      .asSchema(outcomeSchema).pull() as {
        status?: string;
        entry?: { room?: Cell<unknown> };
      };
    expect(outcome?.status).toBe("done");
    const space = outcome!.entry!.room!.space;
    titles.set(space, title);
    return space;
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
    writer = new Runtime({
      apiUrl,
      storageManager: writerStorage,
      experimental: { serverExecution: false },
    });
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
    for (let i = 0; i < MARKED; i++) {
      marked.push(await createGroup(home, `marked-${i}`));
    }
    for (let i = 0; i < UNMARKED; i++) {
      unmarked.push(await createGroup(home, `unmarked-${i}`));
    }

    // Home's own private inbox, holding the sender's notice of each room.
    await send(writer, home, ["ensurePrivateInbox"], {});
    await home.pull();
    const inbox = home.key("privateInbox").key("piece").asSchema(
      { type: "unknown", asCell: ["cell"] } as const,
    ).get() as Cell<unknown> | undefined;
    if (inbox === undefined) throw new Error("Home made no private inbox");
    const rows = [...marked, ...unmarked].map((space) => ({
      kind: "fabrichat-room",
      id: `changed:${space}`,
      space,
      host: apiUrl.origin,
      ownerOrigin: apiUrl.origin,
      title: "",
      from: sender,
      sharedAt: SHARED_AT,
      receivedAt: SHARED_AT,
      toProfile: null,
      changes: { title: true },
    }));
    // The catalog lists every room under a title unlike the room's, and marks
    // the notices of the first rooms acted on, as when a client acted on them
    // before this one started.
    const catalog = home.key("sharedSpaceCatalogStorage").resolveAsCell();
    const delivered = await writer.editWithRetry((tx) => {
      // The inbox's `offers` is a redirect to the cell holding the list,
      // which is the one written.
      inbox.resolveAsCell().withTx(tx).asSchema(inboxSchema).key("offers")
        .resolveAsCell().set(rows);
    });
    expect(delivered.error).toBeUndefined();
    const staged = await writer.editWithRetry((tx) => {
      const entries = catalog.withTx(tx).key("entries" as never);
      for (const space of [...marked, ...unmarked]) {
        entries.key(space as never).key("title" as never).set(STALE as never);
      }
      catalog.withTx(tx).key("notices" as never).set(
        Object.fromEntries(
          marked.map((space) => [noticeKey(space), SHARED_AT]),
        ) as never,
      );
    });
    expect(staged.error).toBeUndefined();
    await writer.idle();
    await writerStorage.synced();
  });

  afterAll(async () => {
    await writer?.dispose();
    await writerStorage?.close();
    await server?.close();
    await http?.shutdown();
  });

  /**
   * Brings up a fresh client of the owner's Home, recording the documents each
   * space delivers to it from its start, and runs its share intake until it
   * has taken up every notice. Returns what arrived, by space, how many pieces
   * of the rooms' spaces an event's delivery started meanwhile, and what the
   * catalog then holds.
   */
  const runClient = async (): Promise<{
    arrived: Map<string, Set<string>>;
    started: number;
    catalog: {
      entries?: Record<string, { title?: string }>;
      notices?: Record<string, number>;
    };
  }> => {
    const storage = EmulatedStorageManager.connectTo(server, { as: owner });
    const arrived = new Map<string, Set<string>>();
    storage.subscribe({
      next(notification) {
        if (
          notification.type === "load" || notification.type === "pull" ||
          notification.type === "integrate"
        ) {
          const ids = arrived.get(notification.space) ?? new Set<string>();
          for (const change of notification.changes) {
            ids.add(change.address.id);
          }
          arrived.set(notification.space, ids);
        }
        return undefined;
      },
    });
    const runtime = new Runtime({
      apiUrl,
      storageManager: storage,
      experimental: { serverExecution: false },
    });
    try {
      const home = await bringUpHome(runtime);
      const mark = runtime.runner.eventStartMark;
      const intake = startShareIntakeOf(runtime, home, owner.did());
      if (intake === undefined) throw new Error("Home has no intake stream");
      try {
        await intake.idle();
        await runtime.idle();
        await storage.synced();
      } finally {
        intake.stop();
      }
      const spaces = new Set<string>([...marked, ...unmarked]);
      const started = runtime.runner.eventStartsSince(mark)
        .filter((link) => spaces.has(link.space)).length;
      const catalog = await home.key("sharedSpaceCatalogStorage")
        .asSchema(catalogSchema).pull() as Awaited<
          ReturnType<typeof runClient>
        >["catalog"];
      return { arrived, started, catalog };
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  };

  /** How many documents each of `spaces` delivered, as `arrived` records. */
  const arrivedIn = (
    arrived: Map<string, Set<string>>,
    spaces: readonly string[],
  ): number[] => spaces.map((space) => arrived.get(space)?.size ?? 0);

  it("reads the rooms of the notices the catalog does not mark, and no document of a marked one's space, and a client after it reads none", async () => {
    const first = await runClient();

    expect(arrivedIn(first.arrived, marked)).toEqual(marked.map(() => 0));
    for (const count of arrivedIn(first.arrived, unmarked)) {
      expect(count).toBeGreaterThan(0);
    }
    expect(first.started).toBe(0);
    expect(
      [...marked, ...unmarked].map((space) =>
        first.catalog.entries?.[space]?.title
      ),
    ).toEqual([
      ...marked.map(() => STALE),
      ...unmarked.map((space) => titles.get(space)),
    ]);
    expect(first.catalog.notices).toEqual(
      Object.fromEntries(
        [...marked, ...unmarked].map((space) => [noticeKey(space), SHARED_AT]),
      ),
    );

    const second = await runClient();

    expect(arrivedIn(second.arrived, [...marked, ...unmarked])).toEqual(
      [...marked, ...unmarked].map(() => 0),
    );
  });
});
