/**
 * When a FabriChat manager reads its rooms' rosters for the people it lists:
 * a client rendering Home's view, which shows the manager, or a room's view,
 * which shows its add panel's picker, runs no reader of another room's roster
 * until the session asks for the people, as opening a picker of them does,
 * and Home's runs one per listed room once it has. An add naming its member
 * by principal alone reads the roster of the room it adds them to, and of no
 * other room.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import { createSession, Identity } from "@commonfabric/identity";
import { WorkerReconciler } from "@commonfabric/html/worker";
import { type Cell, Runtime, UI } from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
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

const owner = await Identity.fromPassphrase("FabriChat lazy people owner");
const member = await Identity.fromPassphrase("FabriChat lazy people member");

const PATTERNS = fromFileUrl(new URL("../../../patterns/", import.meta.url));

/** How many group rooms the owner keeps, each listing the member. */
const GROUPS = 3;

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
  event: unknown,
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

describe("fabrichat-lazy-people", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let http: Deno.HttpServer<Deno.NetAddr>;
  let apiUrl: URL;
  let rooms: Cell<unknown>[];
  let client: Awaited<ReturnType<typeof homeOf>>;
  let cancelRender: () => void;

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

    const owners = await homeOf(server, apiUrl, owner);
    const members = await homeOf(server, apiUrl, member);
    for (
      const [{ runtime, home }, name] of [
        [owners, "Lazy owner"],
        [members, "Lazy member"],
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

    // Each group names the member by their profile, which puts them on the
    // room's roster, so that each roster holds someone for the people to be
    // drawn from, and leaves no notice, whose reading would read the room.
    await members.storage.synced();
    const profile = owners.runtime.getCellFromLink(
      members.home.key("profiles").key(0).resolveAsCell()
        .getAsNormalizedFullLink(),
    );
    rooms = [];
    for (let i = 0; i < GROUPS; i++) {
      const requestId = `group-${i}`;
      await send(
        owners.runtime,
        owners.home,
        ["chatManager", "createGroup"],
        trusted(
          { requestId, title: requestId, members: [], profiles: [profile] },
          "ChatStartSurface",
          "ChatStart",
        ),
      );
      const outcome = await owners.home.key("chatManager").key("requests")
        .key(requestId).asSchema(outcomeSchema).pull() as {
          entry?: { room?: Cell<unknown> };
        };
      rooms.push(outcome.entry!.room!);
    }
    for (const side of [members, owners]) {
      await side.runtime.idle();
      await side.storage.synced();
      await side.runtime.dispose();
      await side.storage.close();
    }

    // A client of the owner's that has loaded none of the rooms renders
    // Home's view through the worker's reconciler, as a page showing it does.
    client = await homeOf(server, apiUrl, owner, { serverExecution: false });
    cancelRender = new WorkerReconciler({ onOps: () => {} }).mount(
      client.home.key(UI).asSchema(rendererVDOMSchema),
    );
    // What the render reads arrives from the server once the client has
    // synced, and what reads it runs again once it is idle.
    await client.runtime.idle();
    await client.storage.synced();
    await client.runtime.idle();
  });

  afterAll(async () => {
    cancelRender?.();
    await client?.runtime.dispose();
    await client?.storage.close();
    await server?.close();
    await http?.shutdown();
  });

  /**
   * How many of `runtime`'s actions read the roster of a room of `rooms`,
   * and how many times they have run, by the scheduler's own record of each
   * action's reads.
   */
  const rosterReadersOf = (
    runtime: Runtime,
    of: readonly Cell<unknown>[],
  ): { readers: number; runs: number } => {
    const readers = runtime.scheduler.getGraphSnapshot().nodes.filter(
      (node) =>
        (node.reads ?? []).some((read) =>
          of.some((room) => read.startsWith(`${room.space}/`)) &&
          read.includes("/roster")
        ),
    );
    return {
      readers: readers.length,
      runs: readers.reduce((sum, node) => sum + (node.stats?.runCount ?? 0), 0),
    };
  };

  describe("a rendered Home", () => {
    it("runs no reader of a room's roster before the session asks for the people", () => {
      expect(rosterReadersOf(client.runtime, rooms)).toEqual({
        readers: 0,
        runs: 0,
      });
    });

    it("runs one reader of each listed room's roster, twice, once the session asks for the people", async () => {
      // Each reader runs as the session asks, and once more as its roster's
      // document arrives; that is all a picker waits on before it lists anyone.

      await send(
        client.runtime,
        client.home,
        ["chatManager", "askForPeople"],
        {},
      );

      expect(rosterReadersOf(client.runtime, rooms)).toEqual({
        readers: GROUPS,
        runs: 2 * GROUPS,
      });
    });
  });

  describe("an add naming no profile", () => {
    it("offers the room through the profile the room's roster lists, reading no other room", async () => {
      // A client of the owner's of its own, which renders nothing, has the
      // manager offer the first room to the member, named by principal alone,
      // as a room's add does once it has admitted them.

      const adder = await homeOf(server, apiUrl, owner, {
        serverExecution: false,
      });
      try {
        const requestId = "add-member-by-principal";
        await send(adder.runtime, adder.home, ["chatManager", "offerRoom"], {
          requestId,
          room: adder.runtime.getCellFromLink(
            rooms[0].getAsNormalizedFullLink(),
          ),
          member: member.did(),
        });
        await adder.runtime.idle();
        const outcome = await adder.home.key("chatManager").key("requests")
          .key(requestId).asSchema(
            {
              type: "object",
              properties: {
                status: { type: "string" },
                delivery: { type: "string" },
              },
            } as const,
          ).pull();
        const others = rooms.slice(1).map((room) => room.space);
        const held = (adder.runtime.getSizes().storage?.bySpace ?? [])
          .filter((entry) => others.includes(entry.space))
          .reduce((sum, entry) => sum + entry.documents, 0);

        expect(outcome).toEqual({ status: "done", delivery: "offered" });
        expect(held).toBe(0);
      } finally {
        await adder.runtime.dispose();
        await adder.storage.close();
      }
    });
  });

  describe("a rendered room", () => {
    it("runs no reader of another room's roster before the session asks for the people", async () => {
      // The room is started and its view rendered on a client of the owner's
      // of its own, as a page opening the room does; the owner can add
      // people to it, so its view holds the add panel's picker.

      const viewer = await homeOf(server, apiUrl, owner, {
        serverExecution: false,
      });
      const room = viewer.runtime.getCellFromLink(
        rooms[1].getAsNormalizedFullLink(),
      );
      await viewer.runtime.start(room);
      const cancel = new WorkerReconciler({ onOps: () => {} }).mount(
        room.key(UI).asSchema(rendererVDOMSchema),
      );
      try {
        await viewer.runtime.idle();
        await viewer.storage.synced();
        await viewer.runtime.idle();

        expect(
          rosterReadersOf(viewer.runtime, [rooms[0], rooms[2]]),
        ).toEqual({ readers: 0, runs: 0 });
      } finally {
        cancel();
        await viewer.runtime.dispose();
        await viewer.storage.close();
      }
    });
  });
});
