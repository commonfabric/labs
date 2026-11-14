/**
 * A FabriChat room whose message write policy names four writers, as every
 * room set up before the room's other three ways to send stores it, takes
 * this tree's room when it follows its origin, and keeps working afterwards.
 *
 * The room's program is stored in its space as a room set up from it stores
 * it (`fixtures/fabrichat-four-writer-room/`, whose `SOURCE.txt` says where
 * it comes from), and the room is set up from that stored source, as a
 * runtime loading such a room does. It seeds through that program's own
 * handlers, each from its reviewed gesture: two messages, a reaction, and a
 * window. Then the room opens, as a person opening it would, and follows
 * `system:system/fabrichat/room.tsx`, which this tree's patterns route serves.
 *
 * The release appends the three writers the stored policy lacks after its
 * four (`docs/specs/cfc-conformance-statement.md` §10), and the room's stored
 * result keeps its writer claim for the session's windows, which this tree's
 * room still holds. Each case checks the room after that release: what it
 * stores, that its writers send, edit and react, on messages the earlier
 * program stored as on new ones, and which acts on those earlier messages
 * are still refused.
 */

import { expect } from "@std/expect";
import { walk } from "@std/fs";
import { fromFileUrl, relative } from "@std/path";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import { createSession, Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";
import {
  type Cell,
  getPatternIdentityRef,
  getPatternSource,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import {
  loadStoredCfcEnvelope,
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { cfcSchemaEntries } from "../../runner/src/cfc/schema-label-view.ts";
import { writeSourceDocs } from "../../runner/src/compilation-cache/cell-cache.ts";
import type { Engine } from "../../runner/src/harness/engine.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const owner = await Identity.fromPassphrase("FabriChat four-writer room");

const PATTERNS = fromFileUrl(new URL("../../../patterns/", import.meta.url));

const FIXTURE = fromFileUrl(
  new URL("./fixtures/fabrichat-four-writer-room/", import.meta.url),
);

/** The origin a room follows. */
const ROOM_ORIGIN = "system:system/fabrichat/room.tsx";

/**
 * The log lines that say an update refused or lost stored data, by the logger
 * that writes them: a source transition its commit refused, a swap whose setup
 * failed, a stored slot setup dropped, and a piece whose start failed.
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
 * The room's program as the fixture holds it, each module named as the
 * patterns route served it: under `/api/patterns/`, at its path in the
 * release it comes from.
 */
const storedProgram = async (): Promise<RuntimeProgram> => {
  const files: { name: string; contents: string }[] = [];
  for await (const { path } of walk(FIXTURE, { exts: [".txt"] })) {
    const key = relative(FIXTURE, path).replace(/\.txt$/, "");
    if (key === "SOURCE") continue;
    files.push({
      name: `/api/patterns/${key}`,
      contents: await Deno.readTextFile(path),
    });
  }
  return { main: "/api/patterns/fabrichat/room.tsx", files };
};

/**
 * The binding each alternative of the write policy the document `cell`
 * stores at the logical path `path` names, in the order stored, each with the
 * module its stamp names.
 */
const storedPolicy = (
  runtime: Runtime,
  cell: Cell<unknown>,
  path: string,
): { writer: string; module: unknown }[] => {
  const tx = runtime.edit();
  try {
    const stored = loadStoredCfcEnvelope(tx, cell.getAsNormalizedFullLink());
    expect(stored.status).toBe("loaded");
    if (stored.status !== "loaded") return [];
    const entry = cfcSchemaEntries(stored.schema).find((entry) =>
      entry.path.join("/") === path
    );
    const ifc = (entry?.schema as { ifc?: { writePolicyAnyOf?: unknown[] } })
      ?.ifc;
    return (ifc?.writePolicyAnyOf ?? []).map((alternative) => {
      const writer = (alternative as {
        writeAuthorizedBy: {
          __ctWriterIdentityOf: { path: string[]; moduleIdentity?: string };
        };
      }).writeAuthorizedBy.__ctWriterIdentityOf;
      return { writer: writer.path.join("."), module: writer.moduleIdentity };
    });
  } finally {
    tx.abort("stored policy read");
  }
};

describe("fabrichat-four-writer-room-update", () => {
  // Set up once, in `beforeAll()`: the room on its stored program, seeded,
  // then updated to this tree's room. Each test reads what that left, so each
  // holds on its own.
  let server: ReturnType<typeof newLoopbackServer>;
  let http: Deno.HttpServer<Deno.NetAddr>;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  let controller: PiecesController;
  let roomController: PiecesController;
  let room: Cell<unknown>;
  let previousIdentity: string | undefined;
  let releasedIdentity: string;
  let storedBefore: { writer: string; module: unknown }[];
  let windowsBefore: unknown;
  let failuresBefore: Record<string, number>;
  let failuresAfter: Record<string, number>;

  /** Sends `event` to the room's `stream`, and waits for what it does. */
  const send = async (
    stream: string,
    event: Record<string, unknown>,
  ): Promise<void> => {
    const tx = runtime.edit();
    room.withTx(tx).key(stream).send(event);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
  };

  /** The room's stored messages, as cells, in the order recorded. */
  const storedMessages = () =>
    room.getArgumentCell<unknown>()!.key("messages")
      .asSchema<Cell<unknown>[]>(asCells).pull();

  /** What each stored message's body reads as. */
  const bodies = async () =>
    await Promise.all(
      (await storedMessages()).map((message) => message.key("body").pull()),
    );

  /** The emoji of each reaction stored on the message `message`. */
  const reactionsOn = async (message: Cell<unknown>) =>
    ((await message.key("reactions").pull()) as { emoji?: string }[] ?? [])
      .map((reaction) => reaction?.emoji);

  /** The document the room's result links for the session's windows. */
  const windowsDocument = () => {
    const { space, id, scope } = room.key("messages").key("windows")
      .resolveAsCell().getAsNormalizedFullLink();
    return { space, id, scope };
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
    storage = EmulatedStorageManager.connectTo(server, { as: owner });
    runtime = new Runtime({
      apiUrl: new URL(`http://127.0.0.1:${http.addr.port}`),
      storageManager: storage,
    });
    controller = new PiecesController(
      createSession({ identity: owner, spaceDid: owner.did() }),
      runtime,
    );
    // Home, and the profile a room's `#profile` wish finds.
    const home = (await controller.ensureDefaultPattern()).getCell();
    await runtime.idle();
    await home.pull();
    {
      const tx = runtime.edit();
      home.withTx(tx).key("createProfile").send(
        trusted(
          { target: { value: "Four-writer owner" } },
          "ProfileCreateSurface",
          "CreateProfile",
        ),
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
    }

    // The room's space, whose access list makes its creator an OWNER, as a
    // manager's room's does.
    const space = await runtime.createSpace();
    roomController = new PiecesController(
      createSession({ identity: owner, spaceDid: space }),
      runtime,
    );
    await roomController.synced();

    // The room's program, stored in the space as a room set up from it
    // stores it, and loaded from there, as a runtime loading the room loads
    // it: both compile the modules as the stored source they are.
    const program = await storedProgram();
    const records = await (runtime.harness as Engine)
      .compileResolvedToRecordGraph(program.files, program.main);
    {
      const tx = runtime.edit();
      writeSourceDocs(
        runtime,
        space,
        records.modules,
        records.entryIdentity,
        tx,
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    const pattern = await runtime.patternManager.loadPatternByIdentity(
      records.entryIdentity,
      "default",
      space,
    );
    expect(pattern).toBeDefined();
    room = await roomController.runPersistent(
      pattern!,
      {},
      "four-writer room",
      {
        origin: ROOM_ORIGIN,
      },
    );
    await runtime.idle();
    await room.pull();
    previousIdentity = getPatternIdentityRef(room)?.identity;
    expect(previousIdentity).toBe(records.entryIdentity);
    expect(getPatternSource(room)).toBe(ROOM_ORIGIN);

    // What the room's program stores, through its own handlers.
    await send(
      "sendMessage",
      trusted(
        { requestId: "m1", target: { value: "First" } },
        "ChatSendSurface",
        "ChatSend",
      ),
    );
    await send(
      "sendMessage",
      trusted(
        { requestId: "m2", target: { value: "Second" } },
        "ChatSendSurface",
        "ChatSend",
      ),
    );
    await send(
      "sendMessage",
      trusted(
        { requestId: "m3", target: { value: "Third" } },
        "ChatSendSurface",
        "ChatSend",
      ),
    );
    const [first] = await storedMessages();
    await send(
      "sendReaction",
      trusted(
        { requestId: "r1", message: first, emoji: "👍" },
        "ChatReactSurface",
        "ChatReact",
      ),
    );
    await room.key("messages").key("openWindow").pull();
    {
      const tx = runtime.edit();
      room.withTx(tx).key("messages").key("openWindow").send({
        requestId: "w1",
        windowId: "main",
        from: { before: "end" },
        count: 5,
      });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
    }
    expect(await bodies()).toEqual(["First", "Second", "Third"]);
    storedBefore = storedPolicy(
      runtime,
      room.getArgumentCell<unknown>()!,
      "messages/*",
    );
    windowsBefore = windowsDocument();

    // The release: the room opens as a person opening it would, follows its
    // origin to this tree's room, and waits for the running room to swap.
    failuresBefore = updateFailureCounts();
    releasedIdentity = await route.identity("system/fabrichat/room.tsx");
    await roomController.openPiece(room);
    await runtime.idle();
    room = await room.withTx().sync();
    failuresAfter = updateFailureCounts();
  });

  afterAll(async () => {
    await runtime?.sourceReconciler.idle();
    await roomController?.dispose();
    await controller?.dispose();
    await runtime?.dispose();
    await storage?.close();
    await server?.close();
    await http?.shutdown();
  });

  it("stores a message write policy naming the room's four writers before the release", () => {
    expect(storedBefore.map(({ writer }) => writer)).toEqual([
      "commitSend",
      "commitEdit",
      "commitDelete",
      "commitObliterate",
    ]);
  });

  it("adopts this tree's room, refusing and dropping nothing", () => {
    expect(
      failuresAfter,
      "The update refused or dropped stored data; the log above says why",
    ).toEqual(failuresBefore);
    expect(getPatternIdentityRef(room)?.identity).toBe(releasedIdentity);
    expect(releasedIdentity).not.toBe(previousIdentity);
  });

  it("keeps the four stored alternatives as stored and appends the three the release adds", () => {
    const after = storedPolicy(
      runtime,
      room.getArgumentCell<unknown>()!,
      "messages/*",
    );
    expect(after.slice(0, 4)).toEqual(storedBefore);
    expect(after.map(({ writer }) => writer)).toEqual([
      "commitSend",
      "commitEdit",
      "commitDelete",
      "commitObliterate",
      "commitComposerSend",
      "commitThreadSend",
      "commitReply",
    ]);
    expect(after[4].module).not.toBe(storedBefore[0].module);
  });

  it("keeps the session's windows where the room's result linked them", () => {
    expect(windowsDocument()).toEqual(windowsBefore);
  });

  it("offers `ensureFileStore`, and sends, edits and reacts afterwards, on messages stored before and after", async () => {
    expect(room.key("ensureFileStore").getRaw()).toBeDefined();

    await send(
      "sendMessage",
      trusted({ body: "Fourth" }, "ChatSendSurface", "ChatSend"),
    );
    const messages = await storedMessages();
    const [first] = messages;
    const fourth = messages[3];
    await send(
      "editMessage",
      trusted(
        { message: first, body: "First, edited" },
        "ChatEditSurface",
        "ChatEdit",
      ),
    );
    await send(
      "sendReaction",
      trusted({ message: first, emoji: "🎉" }, "ChatReactSurface", "ChatReact"),
    );
    await send(
      "sendReaction",
      trusted(
        { message: fourth, emoji: "😺" },
        "ChatReactSurface",
        "ChatReact",
      ),
    );

    expect(await first.key("body").pull()).toBe("First, edited");
    expect(await fourth.key("body").pull()).toBe("Fourth");
    expect(await reactionsOn(first)).toEqual(["👍", "🎉"]);
    expect(await reactionsOn(fourth)).toEqual(["😺"]);
  });

  describe("acts on a message stored before the release", () => {
    // TODO(danfuzz): These pin refusals that are wrong for the room (see the
    // `TODO` in `mergeWritePolicyAnyOf()`). Each message the earlier program
    // stored holds, beneath `/reactions/*`, the write policy its
    // `SentReaction` named, with `commitDelete` and `commitObliterate` among
    // its writers, and this tree's `SentReaction` names neither. A deletion or
    // an obliteration writes the whole message, and a window names the
    // messages, and the merge refuses a schema that omits a stored
    // alternative, in every write. Flip these when a ruling lets a later
    // schema omit an alternative the merged envelope keeps.

    /**
     * The refusal messages logged while `act` runs, of those naming a write
     * policy.
     */
    const refusalsDuring = async (act: () => Promise<void>) => {
      using logged = spy(console, "error");
      await act();
      return logged.calls.flatMap((call) =>
        call.args.map((arg) =>
          typeof arg === "string" ? arg : Deno.inspect(arg, { depth: 4 })
        ).filter((text) => text.includes("writePolicyAnyOf must remain stable"))
      );
    };

    it("refuses deleting it, over the reactions' stored write policy", async () => {
      const [, second] = await storedMessages();
      const refusals = await refusalsDuring(() =>
        send(
          "deleteMessage",
          trusted({ message: second }, "ChatDeleteSurface", "ChatDelete"),
        )
      );

      expect(refusals.join("\n")).toContain(
        "writePolicyAnyOf must remain stable at /reactions/*: the candidate " +
          "drops a stored alternative",
      );
      expect(await second.key("body").pull()).toBe("Second");
    });

    it("refuses obliterating it, over the reactions' stored write policy", async () => {
      const [, , third] = await storedMessages();
      const refusals = await refusalsDuring(() =>
        send(
          "obliterateMessage",
          trusted(
            { message: third },
            "ChatObliterateSurface",
            "ChatObliterate",
          ),
        )
      );

      expect(refusals.join("\n")).toContain(
        "writePolicyAnyOf must remain stable at /reactions/*: the candidate " +
          "drops a stored alternative",
      );
      expect(await third.key("body").pull()).toBe("Third");
    });

    it("refuses this tree's `openWindow` setting the window the earlier program wrote, over the messages' reactions' stored write policy", async () => {
      const refusals = await refusalsDuring(async () => {
        const tx = runtime.edit();
        room.withTx(tx).key("messages").key("openWindow").send({
          requestId: "w2",
          windowId: "main",
          from: { before: "end" },
          count: 2,
        });
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.idle();
      });

      expect(refusals.join("\n")).toContain(
        "writePolicyAnyOf must remain stable at " +
          "/main/messages/*/reactions/*: the candidate adds an alternative " +
          "outside a release",
      );
      const windows = await room.key("messages").key("windows").pull() as
        | Record<string, { requestId?: string }>
        | undefined;
      expect(windows?.main?.requestId).toBe("w1");
    });
  });
});
