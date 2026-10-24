/**
 * Rehearses the update every FabriChat change ships as: data stored by the
 * deployed FabriChat, read and written by this tree's FabriChat after Home and
 * each room follow their origins to it.
 *
 * The deployed release is a frozen copy of FabriChat's pattern source, under
 * `fixtures/fabrichat-update-rehearsal/`: every module of
 * `packages/patterns/fabrichat/` and the room's roster module,
 * `loom/participants.tsx`. The test serves that copy through the patterns
 * route in place of the tree's own, and starts Home from its `system:` origin.
 * It seeds through the deployed handlers alone, each from its reviewed
 * gesture, so every record carries the deployed modules as its writers: a
 * profile, a direct room, a group room, the manager's request outcomes, its
 * direct room and its queued notices, and in the group room messages, an edit,
 * a thread reply, a reaction, a refused reaction and an add whose offer the
 * manager answers. The one record written directly is a request still being
 * worked on, which no handler leaves behind on purpose.
 *
 * The group room's view is read as a renderer reads it, before and after the
 * release, so that its message rows exist as the nested pieces a browser
 * leaves behind: a release sets each one up again with the argument the room
 * carries, and a stored argument the new schema refuses fails every row's
 * start on every later open.
 *
 * It then serves the tree's source and opens Home and each room as a person
 * would. That open is how a deployed FabriChat piece takes a release: Home
 * follows `system:system/home.tsx`, each room the `system:fabrichat/room.tsx`
 * it claimed when the manager created it, and the source reconciler adopts the
 * source each origin now serves. A release adopted that way hands the deployed
 * modules' write authority to their successors (`docs/specs/module-loading.md`,
 * "Module update delegation"), which is what lets the updated handlers write
 * the seeded records. The test checks that each piece adopted the tree's
 * source, that nothing logged a refused transition, a dropped stored slot or a
 * failed start of a nested piece, that every stored slot and per-user outcome
 * reads as it did, that the updated room can edit and react to a seeded
 * message, that the manager lists its rooms and the group room its
 * participants' principals, before and after a room is started, and that
 * starting a direct chat with the same person again finds the room the
 * manager holds.
 *
 * The whole rehearsal runs twice: once with the manager's and the group room's
 * views never read before the update, and once with a client showing Home and
 * reading them first. Which of the two a deployed piece is in decides what it
 * has stored for those views, and so what the update finds there.
 *
 * The copy is only a rehearsal while it matches what is deployed, which is
 * `main`. `deno task refresh-fabrichat-rehearsal` replaces it with
 * `origin/main`'s FabriChat and records the commit in `SOURCE.txt`; a branch
 * changing FabriChat runs it after each merge of `main`, so that its own
 * rehearsal starts from `main`. A branch that breaks the room's stored shape
 * on purpose, which `tasks/pattern-compat-accepted-breaks.ts` records,
 * refreshes the copy from its own tree instead, since the data the deployed
 * release stored is left behind rather than carried over. Where the copy and
 * the tree match, as on `main` itself, the opens find nothing to adopt, and
 * the test still holds the seeded data to reading back and taking writes.
 */

import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import {
  type Cell,
  getPatternIdentityRef,
  getPatternSource,
  isCell,
  Runtime,
} from "@commonfabric/runner";
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

const owner = await Identity.fromPassphrase("FabriChat update rehearsal");

// Principals the owner chats with, none of whom has a profile, so each is
// told of a room by a queued notice.
const counterpart = (await Identity.fromPassphrase("rehearsal counterpart"))
  .did();
const member = (await Identity.fromPassphrase("rehearsal group member")).did();
const added = (await Identity.fromPassphrase("rehearsal added member")).did();

const PATTERNS = fromFileUrl(new URL("..", import.meta.url));

const FROZEN = fromFileUrl(
  new URL("./fixtures/fabrichat-update-rehearsal/", import.meta.url),
);

/**
 * The log lines that say an update refused or lost stored data, by the logger
 * that writes them: a source transition its commit refused, a swap whose setup
 * failed, a stored slot setup dropped, and a nested piece whose start the
 * updated room's setup of it failed.
 */
const UPDATE_FAILURES = [
  ["runner.source-reconcile", "reconcile-failed"],
  ["runner.source-reconcile", "reconcile-commit-failed"],
  ["runner", "pattern-swap-setup-error"],
  ["runner", "pattern-swap-setup-withdrawn"],
  ["runner", "setup-stored-slot-dropped"],
  ["runner", "piece-start-commit-failed"],
] as const;

/** How many of each of `UPDATE_FAILURES` have been logged in this process. */
const updateFailureCounts = (): Record<string, number> =>
  Object.fromEntries(
    UPDATE_FAILURES.map(([logger, key]) => [
      key,
      getLoggerCountsBreakdown()[logger]?.[key]?.total ?? 0,
    ]),
  );

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

/** Reads a link, or a list of links, as cells rather than as copies. */
const asCell = { asCell: ["cell"] } as const;
const asCells = { type: "array", items: asCell } as const;

/**
 * Writes the frozen copy into `directory` under its modules' own names, and
 * links every other file of the tree's `loom/` beside the frozen roster, so the
 * route serves the copy where the tree's FabriChat would be.
 */
const writeFrozenRelease = async (directory: string): Promise<void> => {
  for (const area of ["fabrichat", "loom"]) {
    await Deno.mkdir(join(directory, area));
    for await (const entry of Deno.readDir(join(FROZEN, area))) {
      await Deno.writeTextFile(
        join(directory, area, entry.name.replace(/\.txt$/, "")),
        await Deno.readTextFile(join(FROZEN, area, entry.name)),
      );
    }
  }
  for await (const entry of Deno.readDir(join(PATTERNS, "loom"))) {
    const target = join(directory, "loom", entry.name);
    if (entry.isFile && !(await exists(target))) {
      await Deno.symlink(join(PATTERNS, "loom", entry.name), target);
    }
  }
};

/** Whether anything is at `path`. */
const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

/** A stored slot: where it lives, and the value stored there. */
interface StoredSlot {
  name: string;
  address: { space: string; id: string; path: readonly string[] };
  value: unknown;
}

/**
 * Each slot of the argument document that holds `anchor`'s value, read raw, as
 * stored, with the address it resolves to. A projected read could change as
 * the source rolls; the stored value is what an update has to keep.
 */
const storedSlots = async (
  runtime: Runtime,
  anchor: Cell<unknown>,
): Promise<StoredSlot[]> => {
  const argument = runtime.getCellFromLink({
    ...anchor.resolveAsCell().getAsNormalizedFullLink(),
    path: [],
  });
  await argument.sync();
  const names = Object.keys(
    (argument.getRaw() ?? {}) as Record<string, unknown>,
  ).sort();
  return await Promise.all(names.map(async (name) => {
    const stored = argument.key(name).resolveAsCell();
    await stored.sync();
    const { space, id, path } = stored.getAsNormalizedFullLink();
    return { name, address: { space, id, path }, value: stored.getRaw() };
  }));
};

/**
 * Reads what a renderer reads of `piece`'s view: the view, through
 * `rendererVDOMSchema`, and every cell it binds, each once. The nested pieces
 * the view maps a list to, a room's message rows among them, are set up by
 * that read, as a browser showing the room sets them up.
 */
const render = async (piece: Cell<unknown>): Promise<void> => {
  const read = new Set<string>();
  const visit = async (value: unknown): Promise<void> => {
    if (isCell(value)) {
      const { space, id, scope, path } = value.getAsNormalizedFullLink();
      const address = JSON.stringify([space, id, scope, path]);
      if (read.has(address)) return;
      read.add(address);
      await value.pull();
      return visit(value.get());
    }
    if (Array.isArray(value)) {
      for (const member of value) await visit(member);
    } else if (value !== null && typeof value === "object") {
      for (const member of Object.values(value)) await visit(member);
    }
  };
  await visit(piece.key("$UI").asSchema(rendererVDOMSchema));
};

/** The slots of `after` that `before` holds too, in `after`'s order. */
const kept = (
  after: readonly StoredSlot[],
  before: readonly StoredSlot[],
): StoredSlot[] =>
  after.filter((slot) => before.some(({ name }) => name === slot.name));

/** Each room's kind, in order, as a reader reads a list of rooms. */
const kindsOf = (rooms: unknown): string[] | undefined =>
  Array.isArray(rooms)
    ? rooms.map((entry) => (entry as { kind?: string }).kind ?? "none").sort()
    : undefined;

/**
 * Rehearses the update as `title`. With `readBefore`, a client shows Home and
 * reads the manager's and the group room's views before the update, as one
 * showing them would have. Without it, nothing reads those views until the
 * update has happened. A deployed piece can be updated in either state.
 */
const rehearse = (title: string, readBefore: boolean): void => {
  describe(title, () => {
    // Set up once, in `beforeAll()`: the deployed release, seeded and then
    // updated to this tree's source. Each test reads what that left, so each
    // holds on its own.
    let server: ReturnType<typeof newLoopbackServer>;
    let temporary: string;
    let http: Deno.HttpServer<Deno.NetAddr>;
    let storage: EmulatedStorageManager;
    let runtime: Runtime;
    let controller: PiecesController;
    let route: PatternsRoute;
    let home: Cell<unknown>;
    let manager: Cell<unknown>;
    let directRoom: Cell<unknown>;
    let room: Cell<unknown>;
    let first: Cell<unknown>;
    let second: Cell<unknown>;
    let before: Snapshot;
    let after: Snapshot;
    let failuresBefore: Record<string, number>;
    let failuresAfter: Record<string, number>;
    const adopted: {
      source: string | undefined;
      identity: string | undefined;
      expected: string;
    }[] = [];

    /** Sends `event` to `target`'s `stream`, and waits for what it does. */
    const send = async (
      target: Cell<unknown>,
      stream: string,
      event: Record<string, unknown>,
    ): Promise<void> => {
      const tx = runtime.edit();
      target.withTx(tx).key(stream).send(event);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
    };

    /**
     * The piece a link at `at` names, resolved and readable. Its provenance
     * belongs to the resolved piece, which a read through the link's own opaque
     * reference schema does not reach.
     */
    const pieceAt = async (at: Cell<unknown>): Promise<Cell<unknown>> => {
      const link = await at.asSchema<Cell<unknown>>(asCell).pull();
      expect(link).toBeDefined();
      const handle = runtime.getCellFromLink(
        link!.getAsNormalizedFullLink(),
        {},
      );
      await handle.sync();
      const piece = handle.resolveAsCell();
      await piece.sync();
      return piece;
    };

    /** The group room's newest messages, as cells. */
    const latest = () =>
      room.key("messages").key("latest").key("messages")
        .asSchema<Cell<unknown>[]>(asCells).pull();

    /** What the rehearsal holds to reading back unchanged. */
    const snapshot = async () => ({
      manager: await storedSlots(runtime, manager.key("requests")),
      rooms: await Promise.all(
        [directRoom, room].map((each) =>
          storedSlots(runtime, each.getArgumentCell<unknown>()!)
        ),
      ),
      // Kept per user, outside the room's argument.
      addRequests: await room.key("addRequests").pull(),
      bodies: await Promise.all(
        (await latest()).map((message) => message.key("body").pull()),
      ),
    });
    type Snapshot = Awaited<ReturnType<typeof snapshot>>;

    /**
     * What a client reads of the manager's rooms and of the group room's
     * participants, each directly and through the views a client that draws
     * natively reads. Rooms are listed by kind, sorted, since two rooms started
     * in the same instant may list in either order.
     */
    const views = async () => ({
      rooms: kindsOf(await manager.key("rooms").pull()),
      viewedRooms: kindsOf(
        await manager.key("$VIEWS").key("chats").key("rooms").pull(),
      ),
      principals: await room.key("participantPrincipals").pull(),
      viewedPrincipals: await room.key("$VIEWS").key("room")
        .key("participantPrincipals").pull(),
      entries: ((await room.key("participantEntries").pull()) as
        | { principal?: string }[]
        | undefined)?.map((entry) => entry.principal ?? "none"),
    });
    type Views = Awaited<ReturnType<typeof views>>;
    let viewsBefore: Views | undefined;

    beforeAll(async () => {
      server = newLoopbackServer();
      temporary = await Deno.makeTempDir({
        prefix: "fabrichat-update-rehearsal-",
      });
      await writeFrozenRelease(temporary);
      route = new PatternsRoute(PATTERNS, [
        { routePrefix: "fabrichat/", directory: join(temporary, "fabrichat") },
        { routePrefix: "loom/", directory: join(temporary, "loom") },
      ]);
      http = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        async (request) =>
          await route.serve(request) ??
            new Response("Not found", { status: 404 }),
      );
      const apiUrl = new URL(`http://127.0.0.1:${http.addr.port}`);
      storage = EmulatedStorageManager.connectTo(server, { as: owner });
      runtime = new Runtime({ apiUrl, storageManager: storage });
      controller = new PiecesController(
        createSession({ identity: owner, spaceDid: owner.did() }),
        runtime,
      );

      // The deployed release, and what it stores.
      home = (await controller.ensureDefaultPattern()).getCell();
      expect(getPatternSource(home)).toBe("system:system/home.tsx");
      await runtime.idle();
      await home.pull();

      await send(
        home,
        "createProfile",
        trusted(
          { target: { value: "Rehearsal owner" } },
          "ProfileCreateSurface",
          "CreateProfile",
        ),
      );

      manager = home.key("chatManager");
      await send(
        manager,
        "openDirect",
        trusted(
          { requestId: "direct", counterpart },
          "ChatStartSurface",
          "ChatStart",
        ),
      );
      await send(
        manager,
        "createGroup",
        trusted(
          { requestId: "group", title: "Rehearsal", members: [member] },
          "ChatStartSurface",
          "ChatStart",
        ),
      );
      // A start this user can't make, which the manager refuses.
      await send(
        manager,
        "openDirect",
        trusted(
          { requestId: "refused", counterpart: "not a principal" },
          "ChatStartSurface",
          "ChatStart",
        ),
      );
      // A request still being worked on when the release changes.
      {
        const tx = runtime.edit();
        manager.withTx(tx).key("requests").key("in flight").set({
          status: "pending",
        });
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.idle();
      }

      directRoom = await pieceAt(
        manager.key("direct").key(counterpart).key("room"),
      );
      room = await pieceAt(
        manager.key("requests").key("group").key("entry").key("room"),
      );
      const rooms = [directRoom, room];
      for (const room of rooms) {
        // A room follows the release of its own module, as Home does its.
        expect(getPatternSource(room)).toBe("system:fabrichat/room.tsx");
      }
      await send(
        directRoom,
        "sendMessage",
        trusted(
          { body: "Hello, you" },
          "ChatSendSurface",
          "ChatSend",
        ),
      );
      await send(
        room,
        "sendMessage",
        trusted(
          { body: "First" },
          "ChatSendSurface",
          "ChatSend",
        ),
      );
      await send(
        room,
        "sendMessage",
        trusted(
          { body: "Second" },
          "ChatSendSurface",
          "ChatSend",
        ),
      );
      [first, second] = await latest();
      await send(
        room,
        "editMessage",
        trusted(
          { message: second, body: "Second, edited" },
          "ChatEditSurface",
          "ChatEdit",
        ),
      );
      await send(
        room,
        "sendMessage",
        trusted(
          {
            body: "In the thread",
            replyTo: { message: first, shownIn: "thread" },
          },
          "ChatSendSurface",
          "ChatSend",
        ),
      );
      await send(
        room,
        "sendReaction",
        trusted(
          { message: first, emoji: "👍" },
          "ChatReactSurface",
          "ChatReact",
        ),
      );
      // An act the room drops: a reaction that is not a single emoji.
      await send(
        room,
        "sendReaction",
        trusted(
          { message: first, emoji: "two words" },
          "ChatReactSurface",
          "ChatReact",
        ),
      );
      await send(
        room,
        "addMember",
        trusted(
          { requestId: "add", target: { value: added } },
          "ChatAddMemberSurface",
          "ChatAddMember",
        ),
      );
      await runtime.idle();
      // The rows a browser showing the room would have set up, the thread's
      // root among them.
      await render(room);
      await runtime.idle();
      if (readBefore) {
        await render(home);
        await runtime.idle();
        viewsBefore = await views();
      }

      before = await snapshot();

      // The seed is what the rehearsal is about, so it is checked to be there.
      const managerSlot = (name: string) =>
        before.manager.find((slot) => slot.name === name)?.value;
      expect(managerSlot("requests")).toMatchObject({
        direct: { status: "done" },
        group: { status: "done" },
        refused: { status: "refused" },
        "in flight": { status: "pending" },
      });
      expect(managerSlot("direct")).toHaveProperty(counterpart);
      // One for each person told of a room: the direct room's, the group
      // member's, and the added member's, whom no profile can be offered to.
      expect(managerSlot("outgoingNotices")).toHaveLength(3);
      expect(before.bodies).toEqual(["First", "Second, edited"]);
      expect(before.addRequests).toMatchObject({ add: { status: "done" } });
      for (const slots of before.rooms) {
        expect(slots.map((slot) => slot.name)).toContain("messages");
      }

      // The update to this tree's source.
      failuresBefore = updateFailureCounts();
      // A route made afresh models a release replacing its source cache.
      route = new PatternsRoute(PATTERNS);
      const expected = [
        await route.identity("system/home.tsx"),
        ...rooms.map(() => route.identity("fabrichat/room.tsx")),
      ];
      // Each piece is opened as a person opening it would: the open follows
      // its origin to the source the route now serves, and waits for the
      // running piece to swap to it.
      for (const piece of [home, ...rooms]) await controller.openPiece(piece);
      await runtime.idle();
      // The rows again, as the browser that opened the room shows them: each
      // is set up over the argument the updated room carries.
      await render(room);
      await runtime.idle();

      failuresAfter = updateFailureCounts();
      const resolved = await Promise.all(expected);
      for (const [index, piece] of [home, ...rooms].entries()) {
        const current = await piece.withTx().sync();
        adopted.push({
          source: getPatternSource(current),
          identity: getPatternIdentityRef(current)?.identity,
          expected: resolved[index],
        });
      }
      after = await snapshot();
    });

    afterAll(async () => {
      await runtime?.sourceReconciler.idle();
      await controller?.dispose();
      await runtime?.dispose();
      await storage?.close();
      await server?.close();
      await http?.shutdown();
      if (temporary !== undefined) {
        await Deno.remove(temporary, { recursive: true });
      }
    });

    it("adopts this tree's source for Home and each room, refusing and dropping nothing", () => {
      expect(
        failuresAfter,
        "The update refused or dropped stored data; the log above says which " +
          "piece, and why",
      ).toEqual(failuresBefore);
      for (const { source, identity, expected } of adopted) {
        expect(identity, `${source} did not adopt this tree's source`).toBe(
          expected,
        );
      }
    });

    it("reads back every stored slot and per-user outcome the deployed release wrote", () => {
      // The update may add slots, each with its default; every slot the
      // deployed release stored has to read back as it was.
      expect(
        kept(after.manager, before.manager),
        "The manager's stored slots changed",
      ).toEqual(before.manager);
      after.rooms.forEach((slots, index) =>
        expect(
          kept(slots, before.rooms[index]),
          `Room ${index}'s stored slots changed`,
        ).toEqual(before.rooms[index])
      );
      expect(after.addRequests).toEqual(before.addRequests);
      expect(after.bodies).toEqual(before.bodies);
    });

    it("edits, and changes the reactions on, a message the deployed release stored", async () => {
      // The deployed handlers wrote the seeded records, so each carries their
      // module as its writer. The updated handlers write them through the
      // authority the release hands their modules, so these writes commit only
      // if the update went through a path that hands it on.
      await send(
        room,
        "editMessage",
        trusted(
          { message: second, body: "Second, edited after" },
          "ChatEditSurface",
          "ChatEdit",
        ),
      );
      const firstReaction = first.key("reactions").asSchema<Cell<unknown>[]>(
        asCells,
      ).key(0);
      await send(
        room,
        "deleteReaction",
        trusted(
          { message: first, reaction: firstReaction },
          "ChatReactSurface",
          "ChatUnreact",
        ),
      );
      await send(
        room,
        "sendReaction",
        trusted(
          { message: first, emoji: "🎉" },
          "ChatReactSurface",
          "ChatReact",
        ),
      );
      expect(await second.key("body").pull()).toBe("Second, edited after");
      const emoji = await first.key("reactions").asSchema<{ emoji: string }[]>({
        type: "array",
        items: { type: "object", properties: { emoji: { type: "string" } } },
      }).pull();
      expect(emoji.map((reaction) => reaction.emoji)).toEqual(["🎉"]);
    });

    it("lists the manager's rooms and the group room's participants after the update, and a room started since", async () => {
      const listed = {
        rooms: ["direct", "group"],
        viewedRooms: ["direct", "group"],
        principals: [owner.did()],
        viewedPrincipals: [owner.did()],
        entries: [owner.did()],
      };
      if (readBefore) expect(viewsBefore).toEqual(listed);
      expect(await views()).toEqual(listed);

      await send(
        manager,
        "createGroup",
        trusted(
          { requestId: "group since", title: "Since", members: [member] },
          "ChatStartSurface",
          "ChatStart",
        ),
      );
      expect(
        await manager.key("requests").key("group since").key("status").pull(),
      ).toBe("done");
      expect(await views()).toMatchObject({
        rooms: ["direct", "group", "group"],
        viewedRooms: ["direct", "group", "group"],
      });
    });

    it("finds the direct room the manager holds when a direct chat with the same person starts again", async () => {
      // Starting a direct chat with the same person again writes the
      // manager's seeded records, and finds the room the manager already
      // holds, rather than making a second.
      await send(
        manager,
        "openDirect",
        trusted(
          { requestId: "direct again", counterpart },
          "ChatStartSurface",
          "ChatStart",
        ),
      );
      expect(
        await manager.key("requests").key("direct again").key("status")
          .pull(),
      ).toBe("done");
      const again = await pieceAt(
        manager.key("requests").key("direct again").key("entry").key("room"),
      );
      expect(again.equalLinks(directRoom)).toBe(true);
      const direct = await manager.key("direct").asSchema<
        Record<string, unknown>
      >({ type: "object" }).pull();
      expect(Object.keys(direct)).toEqual([counterpart]);
    });
  });
};

rehearse("FabriChat update rehearsal", false);
rehearse("FabriChat update rehearsal, its views read before the update", true);
