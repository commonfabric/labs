/**
 * A browser tab holds a FabriChat room open while another session of the same
 * person opens the room from a host serving a later release of it, which drops
 * a field the room's result requires. That open adopts the release. Another
 * message is sent afterward, and the tab that held the room across the release
 * shows it.
 *
 * A tab that runs the room itself made its handle on the room under the
 * result schema of the program the room ran when it opened the room, and a
 * handle keeps the schema it was made with, so a reader that requires what
 * the release drops reads nothing through it. A tab under server execution
 * holds the room under the fixed view schema instead. Either way, what the
 * tab draws reads the room's `$UI`, whose view-node links carry the schemas of
 * the program now running, and what it reads by key through the handle it
 * holds is what that program writes.
 *
 * The later release is this tree's FabriChat with `messages.legacyReplies`
 * dropped from the room's result, served by a host of the test's own, which
 * answers the patterns route from that copy, says it released it now, and
 * hands every other request to the run's servers.
 *
 * The posture is the one the run's servers are in. `deno task integration`
 * passes `EXPERIMENTAL_SERVER_EXECUTION` to the servers, the shell and this
 * process alike, so one run covers one posture.
 */

import { expect } from "@std/expect";
import { walk } from "@std/fs";
import { dirname, fromFileUrl, join, relative } from "@std/path";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";

import type { Identity } from "@commonfabric/identity";
import { env, type Page } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import { type Cell, getPatternIdentityRef } from "@commonfabric/runner";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";

import { settleView, waitForSettledText } from "./cfc-browser-helpers.ts";
import {
  closeMember,
  createRoom,
  enterRoom,
  memberIdentity,
  type MemberSession,
  MemberWaits,
  openMember,
  writeAs,
} from "./fabrichat-room-fixture.ts";
import {
  initializePiecesController,
  PieceController,
  type PiecesController,
} from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL } = env;

const PATTERNS = fromFileUrl(new URL("..", import.meta.url));

/** The room's main conversation, which holds one row per message. */
const MESSAGES = "#fabrichat-messages";

/** What the room's starter writes before the release. */
const BEFORE = "Written before the release.";

/** What the starter's other session writes after the release. */
const AFTER = "Written after the release.";

/** The room's own module, as the patterns route names it. */
const ROOM_KEY = "system/fabrichat/room.tsx";

/**
 * Writes this tree's `system/fabrichat/` into `directory`, with the room's
 * result no longer offering `messages.legacyReplies`, which it requires.
 *
 * @throws If the room no longer states or writes the field once each.
 */
const writeReleaseDroppingField = async (directory: string): Promise<void> => {
  const fabrichat = join(PATTERNS, "system", "fabrichat");
  const edits: [string, string][] = [
    [
      "export interface ChatMessageList extends ChatMessageListFacts {",
      "export interface ChatMessageList\n" +
      '  extends Omit<ChatMessageListFacts, "legacyReplies"> {',
    ],
    ["      legacyReplies: facts.list.legacyReplies,\n", ""],
  ];
  for await (const { path, isFile } of walk(fabrichat)) {
    if (!isFile) continue;
    const target = join(directory, relative(fabrichat, path));
    await Deno.mkdir(dirname(target), { recursive: true });
    let source = await Deno.readTextFile(path);
    if (relative(fabrichat, path) === "room.tsx") {
      for (const [from, to] of edits) {
        if (source.split(from).length !== 2) {
          throw new Error(`The room no longer holds ${JSON.stringify(from)}`);
        }
        source = source.replace(from, to);
      }
    }
    await Deno.writeTextFile(target, source);
  }
};

/**
 * A host serving `route` for the patterns route and handing every other
 * request to `upstream`, whose deployment document it repeats with Memory named
 * at `upstream`, so a client of this host opens Memory there.
 */
const serveRelease = (
  route: PatternsRoute,
  upstream: URL,
): Deno.HttpServer<Deno.NetAddr> =>
  Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const served = await route.serve(request);
      if (served !== undefined) return served;
      const url = new URL(request.url);
      const forwarded = new URL(url.pathname + url.search, upstream);
      const response = await fetch(forwarded, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual",
      });
      if (url.pathname !== "/api/meta" || !response.ok) return response;
      const meta = await response.json() as Record<string, unknown>;
      return Response.json({ ...meta, memoryUrl: upstream.origin });
    },
  );

/** A cell handle as the page's runtime client hands it out. */
type PageHandle = {
  key(key: string | number): PageHandle;
  asSchema(schema: unknown): PageHandle;
  pull(): Promise<unknown>;
  id(): string;
};

/** The tab's state this file keeps on the page. */
type HeldState = typeof globalThis & { heldRoom?: PageHandle };

/**
 * A reader's schema for the room's messages that requires the field the
 * release drops, as the result schema of the program the tab opened the room
 * with does.
 */
const STALE_MESSAGES_SCHEMA = {
  type: "object",
  properties: {
    count: { type: "number" },
    legacyReplies: { type: "number" },
  },
  required: ["count", "legacyReplies"],
};

/**
 * Finds the room the shell renders, by `roomId`, its full id, and keeps the
 * handle it renders from on the page, so later reads go through the handle
 * the tab opened the room with.
 *
 * @throws If no `cf-render` renders the room.
 */
async function holdRenderedRoom(page: Page, roomId: string): Promise<void> {
  await page.evaluate((id: string) => {
    const stack: (Document | ShadowRoot)[] = [document];
    const found: string[] = [];
    while (stack.length > 0) {
      const root = stack.pop()!;
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) stack.push(element.shadowRoot);
        if (element.localName !== "cf-render") continue;
        const cell = (element as unknown as { cell?: PageHandle }).cell;
        found.push(String(cell?.id()));
        if (cell?.id() !== id) continue;
        (globalThis as HeldState).heldRoom = cell;
        return;
      }
    }
    throw new Error(
      `No cf-render renders ${id}; those found render ${found.join(", ")}`,
    );
  }, { args: [roomId] });
}

/** What the tab reads of the room's messages. */
interface TabReads {
  /** `messages.count`, through the held handle. */
  count: unknown;

  /** The bodies of `messages.latest.messages`, through the held handle. */
  latest: unknown;

  /** `messages.legacyReplies`, through the held handle. */
  legacyReplies: unknown;

  /**
   * `messages.count`, through the held handle read under
   * {@link STALE_MESSAGES_SCHEMA}.
   */
  staleCount: unknown;
}

/** Reads the room's messages through the handle the tab holds. */
async function tabReads(page: Page): Promise<TabReads> {
  return await page.evaluate(
    async (staleSchema: unknown) => {
      const held = (globalThis as HeldState).heldRoom!;
      const messages = held.key("messages");
      const latest = messages.key("latest").key("messages");
      const length = await latest.key("length").pull() as number | undefined;
      const bodies: unknown[] = [];
      for (let index = 0; index < (length ?? 0); index++) {
        bodies.push(await latest.key(index).key("body").pull());
      }
      const stale = await messages.asSchema(staleSchema).pull() as
        | { count?: unknown }
        | undefined;
      return {
        count: await messages.key("count").pull(),
        latest: length === undefined ? undefined : bodies,
        legacyReplies: await messages.key("legacyReplies").pull(),
        staleCount: stale?.count,
      };
    },
    { args: [STALE_MESSAGES_SCHEMA] },
  );
}

/**
 * Which of `bodies` the main conversation the tab draws holds, in the order
 * it draws them.
 */
async function drawnBodies(page: Page, bodies: string[]): Promise<string[]> {
  return await page.evaluate((selector: string, wanted: string[]) => {
    const stack: (Document | ShadowRoot)[] = [document];
    while (stack.length > 0) {
      const root = stack.pop()!;
      const list = root.querySelector(selector);
      if (list) {
        const text = list.textContent ?? "";
        return wanted.filter((body) => text.includes(body))
          .sort((a, b) => text.indexOf(a) - text.indexOf(b));
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) stack.push(element.shadowRoot);
      }
    }
    return [];
  }, { args: [MESSAGES, bodies] });
}

/** Whether the run's server runs a serving loop. */
async function serverServes(): Promise<boolean> {
  const response = await fetch(new URL("api/health/stats", API_URL));
  if (!response.ok) throw new Error(`Health stats returned ${response.status}`);
  return (await response.json() as { servingLoop?: unknown }).servingLoop !=
    null;
}

describe("fabrichat-held-tab-release", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let starter: Identity;
  let roomId: string;
  let room: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>;
  let temporary: string;
  let host: Deno.HttpServer<Deno.NetAddr> | undefined;
  let route: PatternsRoute;
  let controller: PiecesController | undefined;
  let other: MemberSession | undefined;

  beforeAll(async () => {
    const apiUrl = new URL(API_URL);
    starter = await memberIdentity(
      `fabrichat-held-tab-release ${crypto.randomUUID()}`,
      0,
    );
    const starting = await openMember(apiUrl, starter, 0);
    try {
      const created = await createRoom(starting, []);
      roomId = new PieceController(starting.controller, created).id;
      room = created.getAsNormalizedFullLink();
      await enterRoom(starting, created);
      await writeAs(starting, "the message", { target: { value: BEFORE } }, 1);
    } finally {
      await closeMember(starting);
    }

    temporary = await Deno.makeTempDir({
      prefix: "fabrichat-held-tab-release-",
    });
    await writeReleaseDroppingField(join(temporary, "system", "fabrichat"));
    route = new PatternsRoute(PATTERNS, [{
      routePrefix: "system/fabrichat/",
      directory: join(temporary, "system", "fabrichat"),
    }], { releasedAt: Date.now() });
    host = serveRelease(route, apiUrl);
  });

  afterAll(async () => {
    if (other !== undefined) await closeMember(other);
    else await controller?.dispose();
    await host?.shutdown();
    if (temporary !== undefined) {
      await Deno.remove(temporary, { recursive: true });
    }
  });

  it("shows a message sent after another session's release, in a tab that held the room across it", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid: room.space, pieceId: roomId },
      identity: starter,
    });
    await waitForSettledText(page, MESSAGES, BEFORE);
    await holdRenderedRoom(page, room.id);
    const before = await tabReads(page);
    expect(await drawnBodies(page, [BEFORE, AFTER])).toEqual([BEFORE]);
    expect(before).toMatchObject({
      count: 1,
      latest: [BEFORE],
      legacyReplies: 0,
      staleCount: 1,
    });

    // The starter's other session, opening the room from the host that serves
    // the later release, which the open adopts.
    controller = await initializePiecesController({
      space: starter.did(),
      apiUrl: new URL(`http://127.0.0.1:${host!.addr.port}`),
      identity: starter,
    });
    const serving = controller.runtime.experimental.serverExecution ??
      SERVER_EXECUTION_DEFAULT_ENABLED;
    console.log(
      `fabrichat-held-tab-release posture=${serving ? "on" : "off"}`,
    );
    expect(await serverServes()).toBe(serving);
    const home = (await controller.ensureDefaultPattern()).getCell();
    await controller.runtime.idle();
    other = {
      index: 0,
      identity: starter,
      controller,
      home,
      sent: 1,
      waits: new MemberWaits(controller.runtime.scheduler),
    };
    const opened = await enterRoom(
      other,
      controller.runtime.getCellFromLink(room),
    );
    expect(getPatternIdentityRef(await opened.withTx().sync())?.identity)
      .toBe(await route.identity(ROOM_KEY));

    await writeAs(other, "the later message", { target: { value: AFTER } }, 2);

    await waitForSettledText(page, MESSAGES, AFTER);
    await settleView(page);
    const after = await tabReads(page);
    expect(await drawnBodies(page, [BEFORE, AFTER])).toEqual([BEFORE, AFTER]);
    expect(after.count).toBe(2);
    expect(after.latest).toEqual([BEFORE, AFTER]);
    // What the release dropped is gone from the room, and a reader that still
    // requires it reads nothing of the messages, the count included.
    expect(after.legacyReplies).toBeUndefined();
    expect(after.staleCount).toBeUndefined();
  });
});
