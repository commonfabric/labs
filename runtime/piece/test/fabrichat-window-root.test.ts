/**
 * A FabriChat room opens a thread's window only over a root that is one of
 * its own messages: a link naming the same entity in another space roots no
 * thread there, so the window is not opened.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const owner = await Identity.fromPassphrase("FabriChat window root");

const PATTERNS = fromFileUrl(new URL("../../../patterns/", import.meta.url));

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

const asCells = { type: "array", items: { asCell: ["cell"] } } as const;

describe("fabrichat-window-root", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let http: Deno.HttpServer<Deno.NetAddr>;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  let room: Cell<unknown>;
  let message: Cell<unknown>;

  /** Sends `event` to `piece`'s `stream`, and waits for what it does. */
  const send = async (
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

  /** The session's windows, as the room holds them. */
  const windows = async () =>
    await room.key("messages").key("windows").pull() as
      | Record<string, { requestId?: string; root?: unknown }>
      | undefined;

  beforeAll(async () => {
    server = newLoopbackServer();
    const route = new PatternsRoute(PATTERNS);
    http = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) =>
        await route.serve(request) ??
          new Response("Not found", { status: 404 }),
    );
    storage = EmulatedStorageManager.connectTo(server, { as: owner });
    runtime = new Runtime({
      apiUrl: new URL(`http://127.0.0.1:${http.addr.port}`),
      storageManager: storage,
    });
    const home = (await new PiecesController(
      createSession({ identity: owner, spaceDid: owner.did() }),
      runtime,
    ).ensureDefaultPattern()).getCell();
    await runtime.idle();
    await home.pull();
    await send(
      home,
      ["createProfile"],
      trusted(
        { target: { value: "Window owner" } },
        "ProfileCreateSurface",
        "CreateProfile",
      ),
    );

    const rooms = new PiecesController(
      createSession({ identity: owner, spaceDid: await runtime.createSpace() }),
      runtime,
    );
    await rooms.synced();
    const program = await resolveLocalProgram(
      runtime.harness.resolve.bind(runtime.harness),
      { root: PATTERNS, main: `${PATTERNS}system/fabrichat/room.tsx` },
    );
    room = (await rooms.create(program, { input: {} })).getCell();
    await runtime.idle();
    await room.pull();
    await send(
      room,
      ["sendMessage"],
      trusted({ body: "Root" }, "ChatSendSurface", "ChatSend"),
    );
    [message] = await room.getArgumentCell<unknown>()!.key("messages")
      .asSchema<Cell<unknown>[]>(asCells).pull();
  });

  afterAll(async () => {
    await runtime?.dispose();
    await storage?.close();
    await server?.close();
    await http?.shutdown();
  });

  it("opens a thread's window over one of the room's messages, naming it", async () => {
    await send(room, ["messages", "openWindow"], {
      requestId: "own",
      windowId: "own",
      root: message,
      from: { before: "end" },
      count: 5,
    });

    expect((await windows())?.own?.requestId).toBe("own");
    const named = room.key("messages").key("windows").key("own").key("root")
      .resolveAsCell().getAsNormalizedFullLink();
    const own = message.resolveAsCell().getAsNormalizedFullLink();
    expect([named.space, named.id]).toEqual([own.space, own.id]);
  });

  it("opens no window over a link naming the same entity in another space", async () => {
    const own = message.resolveAsCell().getAsNormalizedFullLink();
    expect(own.space).not.toBe(owner.did());
    const elsewhere = runtime.getCellFromLink({ ...own, space: owner.did() });

    await send(room, ["messages", "openWindow"], {
      requestId: "elsewhere",
      windowId: "elsewhere",
      root: elsewhere,
      from: { before: "end" },
      count: 5,
    });

    expect((await windows())?.elsewhere).toBe(undefined);
  });
});
