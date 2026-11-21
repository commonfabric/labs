/**
 * A FabriChat room whose message write policy names four writers, as every
 * room set up before the room's other three ways to send stores it, takes
 * this tree's room when it follows its origin, and keeps working afterwards.
 *
 * The room's program is stored in its space as a room set up from it stores
 * it (`fixtures/fabrichat-four-writer-room/`, whose `SOURCE.txt` says where
 * it comes from), and the room is set up from that stored source, as a
 * runtime loading such a room does. It seeds through that program's own
 * handlers, each from its reviewed gesture: six messages, one of them a
 * reply, a reaction, and two windows. Then the room opens, as a person opening
 * it would, and follows `system:system/fabrichat/room.tsx`, which this tree's
 * patterns route serves.
 *
 * The release appends the three writers the stored policy lacks after its
 * four (`docs/specs/cfc-conformance-statement.md` §10), and the room's stored
 * result keeps its writer claim for the session's windows, which this tree's
 * room still holds. Each case checks the room after that release: what it
 * stores, that its writers send, edit and react, on messages the earlier
 * program stored as on new ones, and that it deletes, obliterates and windows
 * those earlier messages, whose stored write policies keep writers this
 * tree's room no longer lists.
 */

import { expect } from "@std/expect";
import { walk } from "@std/fs";
import { fromFileUrl, relative } from "@std/path";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import type { FabricPlainObject, FabricValue } from "@commonfabric/api";
import { createSession, Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
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
  readStoredCfcMetadata,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { cfcSchemaEntries } from "../../runner/src/cfc/schema-label-view.ts";
import {
  compiledDocKey,
  loadVerifiedSourceClosure,
  sourceDocKey,
  writeSourceDocs,
} from "../../runner/src/compilation-cache/cell-cache.ts";
import type { Engine } from "../../runner/src/harness/engine.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  storedFields,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import { PieceController } from "../src/ops/piece-controller.ts";
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
 * The released program `modules` holds, keyed by identity, with a comment
 * added to its entry, so that the entry takes another identity: the next
 * release, for a room that runs this one.
 */
const nextReleaseOf = (
  modules: ReadonlyMap<string, { filename: string; code: string }>,
): RuntimeProgram => ({
  main: "/api/patterns/system/fabrichat/room.tsx",
  files: [...modules.values()].map(({ filename, code }) => ({
    name: filename,
    contents: filename.endsWith("/fabrichat/room.tsx")
      ? `${code}\n// The next release.\n`
      : code,
  })),
});

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
  let roomSpace: MemorySpace;
  let previousIdentity: string | undefined;
  let releasedIdentity: string;
  let storedBefore: { writer: string; module: unknown }[];
  let windowsBefore: unknown;
  let argumentClaimsBefore: unknown;
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

  /**
   * What the room's argument stores under its two lone writer claims: the
   * participants `addParticipant` added, and the `about` the room was
   * created with.
   */
  const argumentClaims = () => {
    const stored = room.getArgumentCell<unknown>()!.getRaw() as {
      participants?: { items?: unknown[] };
      about?: unknown;
    };
    return {
      participants: stored.participants?.items?.length,
      about: stored.about,
    };
  };

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
    roomSpace = space;
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
    for (const [requestId, value] of [["m4", "Root"], ["m5", "Twice"]]) {
      await send(
        "sendMessage",
        trusted(
          { requestId, target: { value } },
          "ChatSendSurface",
          "ChatSend",
        ),
      );
    }
    await send(
      "sendMessage",
      trusted(
        {
          requestId: "m6",
          target: { value: "Reply" },
          replyTo: { message: (await storedMessages())[0], shownIn: "main" },
        },
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
    // A member who joined, through the earlier program's own
    // `addParticipant`, and an `about`, so that the room holds a value under
    // each of its two lone writer claims, as rooms people use do. The `about`
    // is planted where a manager's `commitStart` writes it as it creates the
    // room, since this test runs no manager.
    {
      const tx = runtime.edit();
      runtime.getCell(owner.did(), "joined profile", undefined, tx).set({
        name: "Joined",
      });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await send("addParticipant", {
      profile: runtime.getCell(owner.did(), "joined profile"),
    });
    {
      const { id } = room.getArgumentCell<unknown>()!.getAsNormalizedFullLink();
      const address = {
        space: roomSpace,
        scope: "space" as const,
        id,
        path: [],
      };
      const plant = runtime.edit();
      const stored = storedFields(plant, address);
      seedStoredEnvelope(plant, address, {
        ...stored,
        value: {
          ...(stored.value as FabricPlainObject),
          about: { kind: "group", title: "Four writers" },
        },
      });
      expect((await plant.commit().settled).error).toBeUndefined();
      await runtime.idle();
    }
    await room.key("messages").key("openWindow").pull();
    // Two windows: `main`, which a case opens again, and `old`, which a case
    // closes.
    for (const [requestId, windowId] of [["w1", "main"], ["o1", "old"]]) {
      const tx = runtime.edit();
      room.withTx(tx).key("messages").key("openWindow").send({
        requestId,
        windowId,
        from: { before: "end" },
        count: 5,
      });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
    }
    expect(await bodies()).toEqual([
      "First",
      "Second",
      "Third",
      "Root",
      "Twice",
      "Reply",
    ]);
    storedBefore = storedPolicy(
      runtime,
      room.getArgumentCell<unknown>()!,
      "messages/*",
    );
    windowsBefore = windowsDocument();
    argumentClaimsBefore = argumentClaims();

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

  it("proposes for the review the delegations the update's own preparation derives", async () => {
    // The review a `setsrc --check` runs judges an appended writer by the
    // delegations it derives from this session's evaluation of the candidate;
    // the update's setup, by those `prepareSourceUpdate()` derives from the
    // candidate's stored source. For this room they are the same.

    const sorted = (delegations: ReadonlyMap<string, ReadonlySet<string>>) =>
      [...delegations].map(([identity, predecessors]) =>
        [identity, [...predecessors].sort()] as const
      ).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const proposed = await runtime.patternManager
      .proposedSourceUpdateDelegations(
        roomSpace,
        previousIdentity!,
        releasedIdentity,
      );
    const prepared = runtime.patternManager.sourceUpdateDelegations(
      await runtime.patternManager.prepareSourceUpdate(
        roomSpace,
        previousIdentity!,
        releasedIdentity,
      ),
    );

    expect(proposed).toBeDefined();
    expect(sorted(proposed!)).toEqual(sorted(prepared.delegations));
    expect(prepared.delegations.size).toBeGreaterThan(0);
  });

  it("keeps the participant and the `about` its argument stores under their writers' claims", () => {
    expect(argumentClaimsBefore).toEqual({
      participants: 1,
      about: { kind: "group", title: "Four writers" },
    });
    expect(argumentClaims()).toEqual(argumentClaimsBefore);
  });

  it("keeps the session's windows where the room's result linked them", () => {
    expect(windowsDocument()).toEqual(windowsBefore);
  });

  it("offers `ensureFileStore`, which the earlier program lacks", () => {
    expect(room.key("ensureFileStore").getRaw()).toBeDefined();
  });

  it("sends, edits and reacts afterwards, on messages stored before and after", async () => {
    await send(
      "sendMessage",
      trusted({ body: "Fourth" }, "ChatSendSurface", "ChatSend"),
    );
    const messages = await storedMessages();
    const [first] = messages;
    const fourth = messages.at(-1)!;
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
    // Each message the earlier program stored holds, beneath `/reactions/*`,
    // the write policy its `SentReaction` named, with `commitDelete` and
    // `commitObliterate` among its writers, and this tree's `SentReaction`
    // names neither. A deletion or an obliteration writes the whole message,
    // and a window names the messages, so each of these writes a document
    // whose stored policy lists writers this tree's schema omits. The merge
    // keeps them as stored.

    /** The writers of the room's reactions before the release, as stored. */
    const STORED_REACTION_WRITERS = [
      "commitSendReaction",
      "commitDeleteReaction",
      "commitDelete",
      "commitObliterate",
    ];

    /**
     * The row of a window this tree's room opens that shows `message`: its
     * place in the window, as the row names it. The link stored there
     * resolves to the message under the schema the program that sent it
     * stored it with.
     */
    const windowRowOf = async (message: Cell<unknown>) => {
      const today = (await roomController.get(
        room.getAsNormalizedFullLink().id,
      )).getCell();
      const tx = runtime.edit();
      today.withTx(tx).key("messages").key("openWindow").send({
        requestId: "w-rows",
        windowId: "rows",
        from: { after: "start" },
        count: 20,
      });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      const windows = today.key("messages").key("windows").resolveAsCell();
      const link = windows.getAsNormalizedFullLink();
      const docOf = (cell: Cell<unknown>) =>
        cell.resolveAsCell().getAsNormalizedFullLink().id;
      const row = (windows.getRaw() as { rows: { messages: unknown[] } }).rows
        .messages.map((_, index) =>
          runtime.getCellFromLink({
            ...link,
            path: ["rows", "messages", String(index)],
            schema: undefined,
          })
        ).find((cell) => docOf(cell) === docOf(message));
      expect(row).toBeDefined();
      return row!;
    };

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
        ).filter((text) => text.includes("writePolicyAnyOf"))
      );
    };

    it("deletes it, keeping the writers its reactions' policy stores", async () => {
      const [, second] = await storedMessages();
      const refusals = await refusalsDuring(() =>
        send(
          "deleteMessage",
          trusted({ message: second }, "ChatDeleteSurface", "ChatDelete"),
        )
      );

      expect(refusals).toEqual([]);
      expect(await second.key("body").pull()).toEqual({ deleted: true });
      expect(
        storedPolicy(runtime, second, "reactions/*").map(({ writer }) =>
          writer
        ),
      ).toEqual(STORED_REACTION_WRITERS);
    });

    it("deletes one holding reactions", async () => {
      const [first] = await storedMessages();
      expect(await reactionsOn(first)).not.toEqual([]);
      const refusals = await refusalsDuring(() =>
        send(
          "deleteMessage",
          trusted({ message: first }, "ChatDeleteSurface", "ChatDelete"),
        )
      );

      expect(refusals).toEqual([]);
      expect(await first.key("body").pull()).toEqual({ deleted: true });
    });

    it("obliterates it, keeping the writers its reactions' policy stores", async () => {
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

      expect(refusals).toEqual([]);
      expect(await third.key("body").pull()).toEqual({ deleted: true });
      expect((third.getRaw() as { authorProfile?: unknown }).authorProfile)
        .toBeUndefined();
      expect(
        storedPolicy(runtime, third, "reactions/*").map(({ writer }) => writer),
      ).toEqual(STORED_REACTION_WRITERS);
    });

    it("reads a deleted message the earlier program stored as a tombstone, in `count`, `latest` and a window opened afterward", async () => {
      // The handle a message's stored link resolves to keeps the earlier
      // program's schema for it, which requires an `earlierVersions` that
      // the tombstone this tree's room leaves does not hold. The room reads
      // each message under its own schema, so the tombstone still counts.

      const [, second] = await storedMessages();
      await send(
        "deleteMessage",
        trusted({ message: second }, "ChatDeleteSurface", "ChatDelete"),
      );
      const today = (await roomController.get(
        room.getAsNormalizedFullLink().id,
      )).getCell();
      {
        const tx = runtime.edit();
        today.withTx(tx).key("messages").key("openWindow").send({
          requestId: "w-tombstone",
          windowId: "tombstone",
          from: { before: "end" },
          count: 10,
        });
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.idle();
      }
      const bodiesOf = (messages: unknown) =>
        ((messages ?? []) as { body?: unknown }[]).map((message) =>
          message?.body
        );

      expect(await today.key("messages").key("count").pull()).toBe(
        (await storedMessages()).length,
      );
      expect(
        bodiesOf(
          await today.key("messages").key("latest").key("messages")
            .pull(),
        ),
      ).toContainEqual({ deleted: true });
      expect(
        bodiesOf(
          await today.key("messages").key("windows").key("tombstone").key(
            "messages",
          ).pull(),
        ),
      ).toContainEqual({ deleted: true });
    });

    it("opens the thread of a message the earlier program stored, once that message is deleted", async () => {
      const root = (await storedMessages())[3];
      await send(
        "sendMessage",
        trusted(
          {
            body: "In the thread",
            replyTo: { thread: root, shownIn: "thread" },
          },
          "ChatSendSurface",
          "ChatSend",
        ),
      );
      const refusals = await refusalsDuring(() =>
        send(
          "deleteMessage",
          trusted({ message: root }, "ChatDeleteSurface", "ChatDelete"),
        )
      );
      const today = (await roomController.get(
        room.getAsNormalizedFullLink().id,
      )).getCell();
      {
        const tx = runtime.edit();
        today.withTx(tx).key("messages").key("openWindow").send({
          requestId: "w-thread",
          windowId: "thread",
          root,
          from: { after: "start" },
          count: 10,
        });
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.idle();
      }

      expect(refusals).toEqual([]);
      expect(
        ((await today.key("messages").key("windows").key("thread").key(
          "messages",
        ).pull()) as { body?: unknown }[] | undefined)?.map((message) =>
          message?.body
        ),
      ).toEqual([{ deleted: true }, "In the thread"]);
    });

    it("obliterates a message the earlier program stored that its author deleted, named as a row of a window names it, dropping the author", async () => {
      // A row of a window names its message by its place in the window,
      // whose stored link resolves to it under the schema the earlier program
      // stored it with, in a window this tree's room opens as in one the
      // earlier program did. Its tombstone doesn't fit that schema, so the
      // act reads the message through the link it was given.

      const twice = (await storedMessages())[4];
      const shown = await windowRowOf(twice);
      const refusals = await refusalsDuring(async () => {
        await send(
          "deleteMessage",
          trusted({ message: shown }, "ChatDeleteSurface", "ChatDelete"),
        );
        await send(
          "obliterateMessage",
          trusted(
            { message: shown },
            "ChatObliterateSurface",
            "ChatObliterate",
          ),
        );
      });

      expect(refusals).toEqual([]);
      expect(await twice.key("body").pull()).toEqual({ deleted: true });
      expect((twice.getRaw() as { authorProfile?: unknown }).authorProfile)
        .toBeUndefined();
    });

    it("deletes a reply the earlier program stored, named as a row of a window names it, keeping what it replies to", async () => {
      const reply = (await storedMessages())[5];
      const shown = await windowRowOf(reply);
      const refusals = await refusalsDuring(() =>
        send(
          "deleteMessage",
          trusted({ message: shown }, "ChatDeleteSurface", "ChatDelete"),
        )
      );

      expect(refusals).toEqual([]);
      expect(await reply.key("body").pull()).toEqual({ deleted: true });
      const [first] = await storedMessages();
      const docOf = (cell: Cell<unknown>) =>
        cell.resolveAsCell().getAsNormalizedFullLink().id;
      expect(
        (reply.getRaw() as { replyTo?: { shownIn?: unknown } }).replyTo
          ?.shownIn,
      ).toBe("main");
      expect(docOf(reply.key("replyTo").key("message"))).toBe(docOf(first));
    });

    it("writes nothing for a `closeWindow` naming no open window, under a name an object inherits", async () => {
      // A close of a window that isn't open changes nothing, so it makes no
      // write the stored policy could refuse.

      const refusals = await refusalsDuring(async () => {
        const tx = runtime.edit();
        room.withTx(tx).key("messages").key("closeWindow").send({
          requestId: "c1",
          windowId: "valueOf",
        });
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.idle();
      });

      expect(refusals).toEqual([]);
    });

    it("closes a window the earlier program wrote, through this tree's `closeWindow`", async () => {
      const windows = room.key("messages").key("windows").resolveAsCell();
      expect(
        Object.keys((windows.getRaw() ?? {}) as Record<string, unknown>),
      ).toContain("old");
      const refusals = await refusalsDuring(async () => {
        const tx = runtime.edit();
        room.withTx(tx).key("messages").key("closeWindow").send({
          requestId: "c-old",
          windowId: "old",
        });
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.idle();
      });

      expect(refusals).toEqual([]);
      expect(
        Object.keys((windows.getRaw() ?? {}) as Record<string, unknown>),
      ).not.toContain("old");
    });

    it("sets the window the earlier program wrote through this tree's `openWindow`, keeping the writers the window stores for its messages' reactions", async () => {
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

      expect(refusals).toEqual([]);
      const today = (await roomController.get(
        room.getAsNormalizedFullLink().id,
      )).getCell();
      const windows = today.key("messages").key("windows");
      expect(await windows.key("main").key("requestId").pull()).toBe("w2");
      expect(
        storedPolicy(
          runtime,
          windows.resolveAsCell(),
          "main/messages/*/reactions/*",
        ).map(({ writer }) => writer),
      ).toEqual(STORED_REACTION_WRITERS);
    });
  });
  describe("with the room's own space labeling its argument", () => {
    // A room in a space of its own whose argument carries that space's
    // personal space, a label the room fits, updated as a person opening it
    // updates it. The update reads the argument, and its join reaches what it
    // writes but not the released program's records, which a room set up from
    // that program in the same space then reads unlabeled.

    let labeledSpace: MemorySpace;
    let labeledController: PiecesController;
    let labeledRoom: Cell<unknown>;
    let released: Map<string, { filename: string; code: string }>;
    let releasedRecords: Cell<unknown>[];

    beforeAll(async () => {
      labeledSpace = await runtime.createSpace();
      labeledController = new PiecesController(
        createSession({ identity: owner, spaceDid: labeledSpace }),
        runtime,
      );
      await labeledController.synced();
      const program = await storedProgram();
      const records = await (runtime.harness as Engine)
        .compileResolvedToRecordGraph(program.files, program.main);
      {
        const tx = runtime.edit();
        writeSourceDocs(
          runtime,
          labeledSpace,
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
        labeledSpace,
      );
      labeledRoom = await labeledController.runPersistent(
        pattern!,
        {},
        "labeled room",
        { origin: ROOM_ORIGIN },
      );
      await runtime.idle();
      await labeledRoom.pull();

      const label = {
        confidentiality: [{
          type: "https://commonfabric.org/cfc/atom/PersonalSpace",
          owner: labeledSpace,
        }],
      };
      const { id } = labeledRoom.getArgumentCell<unknown>()!
        .getAsNormalizedFullLink();
      const address = {
        space: labeledSpace,
        scope: "space" as const,
        id,
        path: [],
      };
      const plant = runtime.edit();
      const stored = storedFields(plant, address) as FabricPlainObject & {
        cfc?: FabricPlainObject & {
          labelMap: FabricPlainObject & { entries: FabricValue[] };
        };
      };
      if (stored.cfc === undefined) writeSeedEnvelopeDoc(plant, labeledSpace);
      const cfc = stored.cfc ?? {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [] },
      };
      seedStoredEnvelope(plant, address, {
        ...stored,
        cfc: {
          ...cfc,
          labelMap: {
            ...cfc.labelMap,
            entries: [
              ...cfc.labelMap.entries,
              { path: [], origin: "structure", observes: "shape", label },
              { path: [], label },
            ],
          },
        },
      });
      expect((await plant.commit().settled).error).toBeUndefined();

      await labeledController.openPiece(labeledRoom);
      await runtime.idle();
      labeledRoom = await labeledRoom.withTx().sync();

      const version = await runtime.patternManager.compileCacheRuntimeVersion({
        patternCoverage: false,
      });
      const tx = runtime.edit();
      const closure = await loadVerifiedSourceClosure(
        runtime,
        labeledSpace,
        releasedIdentity,
        tx,
      );
      tx.abort("released closure read");
      expect(closure).toBeDefined();
      released = new Map(
        [...closure!].map(([identity, doc]) => [identity, {
          filename: doc.filename,
          code: doc.code,
        }]),
      );
      releasedRecords = [...released.keys()].flatMap((identity) =>
        [sourceDocKey(identity), compiledDocKey(version!, identity)].map((
          key,
        ) => runtime.getCell(labeledSpace, key))
      );
    });

    it("moves the room to the released program, staging the delegations it derives", async () => {
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.idle();
      expect(getPatternIdentityRef(labeledRoom)?.identity).toBe(
        releasedIdentity,
      );
      expect(
        (runtime.getCell(labeledSpace, sourceDocKey(releasedIdentity))
          .getRaw() as { delegatedModuleIdentities?: string[] })
          ?.delegatedModuleIdentities,
      ).toContain(previousIdentity);
    });

    it("leaves every released record carrying no confidentiality", () => {
      const tx = runtime.edit();
      try {
        for (const record of releasedRecords) {
          const { id } = record.getAsNormalizedFullLink();
          expect(
            (readStoredCfcMetadata(tx, { space: labeledSpace, id })?.labelMap
              .entries ?? []).flatMap((entry) =>
                entry.label.confidentiality ?? []
              ),
            id,
          ).toEqual([]);
        }
      } finally {
        tx.abort("released record labels read");
      }
    });

    it("sets up a fresh room from the released program", async () => {
      const pattern = await runtime.patternManager.loadPatternByIdentity(
        releasedIdentity,
        "default",
        labeledSpace,
      );
      const fresh = await labeledController.runPersistent(
        pattern!,
        {},
        "fresh room",
        { origin: ROOM_ORIGIN },
      );
      await runtime.idle();
      await fresh.pull();

      expect(getPatternIdentityRef(fresh)?.identity).toBe(releasedIdentity);
    });

    it("updates the room again, to the released program with its entry edited", async () => {
      await new PieceController(labeledController, labeledRoom).setPattern(
        nextReleaseOf(released),
      );
      await runtime.idle();

      const updated = getPatternIdentityRef(await labeledRoom.withTx().sync());
      expect(updated?.identity).not.toBe(releasedIdentity);
    });
  });

  describe("with the released program's records storing another member's label", () => {
    // The labels a source update of a room whose own data carries another
    // member's personal space left on the released program's records, on a
    // runtime that staged the update's delegations in its transition: the
    // entries such a runtime was measured to leave at the delegation field,
    // and those a later write-back of the record left at its root. A room set
    // up from that program in the same space reads them, and the load ahead
    // of the setup repairs them, warm or cold. Last in the file, so that no
    // other case here runs over the planted labels.

    const personalSpaceOf = async (passphrase: string) => ({
      type: "https://commonfabric.org/cfc/atom/PersonalSpace",
      owner: (await Identity.fromPassphrase(passphrase)).did(),
    });

    let otherMember: { type: string; owner: string };
    let records: Cell<unknown>[];
    let releasedModules: Map<string, { filename: string; code: string }>;

    beforeAll(async () => {
      otherMember = await personalSpaceOf("FabriChat four-writer other member");
      const version = await runtime.patternManager.compileCacheRuntimeVersion({
        patternCoverage: false,
      });
      const tx = runtime.edit();
      const closure = await loadVerifiedSourceClosure(
        runtime,
        roomSpace,
        releasedIdentity,
        tx,
      );
      tx.abort("released closure read");
      expect(closure).toBeDefined();
      releasedModules = new Map(
        [...closure!].map(([identity, doc]) => [identity, {
          filename: doc.filename,
          code: doc.code,
        }]),
      );
      // A module this runtime has not compiled has no compiled record.
      records = [...releasedModules.keys()].flatMap((identity) =>
        [sourceDocKey(identity), compiledDocKey(version!, identity)].map((
          key,
        ) => runtime.getCell(roomSpace, key))
      ).filter((record) => record.getRaw() !== undefined);
      const plant = runtime.edit();
      for (const record of records) {
        const { id } = record.getAsNormalizedFullLink();
        const address = {
          space: roomSpace,
          scope: "space" as const,
          id,
          path: [],
        };
        const stored = storedFields(plant, address) as FabricPlainObject & {
          cfc?: FabricPlainObject & {
            labelMap: FabricPlainObject & { entries: FabricValue[] };
          };
        };
        if (stored.cfc === undefined) writeSeedEnvelopeDoc(plant, roomSpace);
        const cfc = stored.cfc ?? {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: { version: 1, entries: [] },
        };
        seedStoredEnvelope(plant, address, {
          ...stored,
          cfc: {
            ...cfc,
            labelMap: {
              ...cfc.labelMap,
              entries: [
                ...cfc.labelMap.entries,
                ...([
                  [["delegatedModuleIdentities"], "structure", "enumerate"],
                  [["delegatedModuleIdentities"], "structure", "shape"],
                  [
                    ["delegatedModuleIdentities", "*"],
                    "structure",
                    "followRef",
                  ],
                  [["delegatedModuleIdentities", "*"], "structure", "shape"],
                  [["delegatedModuleIdentities", "*"], "structure", "value"],
                  [["delegatedModuleIdentities", "0"], "derived", "shape"],
                  [["delegatedModuleIdentities", "0"], "derived", "value"],
                  [[], "derived", "shape"],
                  [[], "derived", "value"],
                ] as const).map(([path, origin, observes]) => ({
                  path: [...path],
                  origin,
                  observes,
                  label: {
                    confidentiality: [otherMember],
                    ...(path.length === 0 && observes === "value"
                      ? {
                        integrity: [{
                          type:
                            "https://commonfabric.org/cfc/atom/TransformedBy",
                          identity: {
                            kind: "builtin",
                            builtinId: "compile-cache",
                          },
                        }],
                      }
                      : {}),
                  },
                })),
              ],
            },
          },
        });
      }
      expect((await plant.commit().settled).error).toBeUndefined();
    });

    /** Sets up a fresh room from the released program, through `pieces`. */
    const freshRoom = async (on: Runtime, pieces: PiecesController) => {
      const pattern = await on.patternManager.loadPatternByIdentity(
        releasedIdentity,
        "default",
        roomSpace,
      );
      expect(pattern).toBeDefined();
      const fresh = await pieces.runPersistent(
        pattern!,
        {},
        "fresh room",
        { origin: ROOM_ORIGIN },
      );
      await on.idle();
      await fresh.pull();
      return fresh;
    };

    it("sets up a fresh room from the released program", async () => {
      const fresh = await freshRoom(runtime, roomController);

      expect(getPatternIdentityRef(await fresh.withTx().sync())?.identity)
        .toBe(releasedIdentity);
    });

    it("sets up a fresh room from the released program on a runtime that starts cold", async () => {
      const coldStorage = EmulatedStorageManager.connectTo(server, {
        as: owner,
      });
      const cold = new Runtime({
        apiUrl: new URL(`http://127.0.0.1:${http.addr.port}`),
        storageManager: coldStorage,
      });
      const coldPieces = new PiecesController(
        createSession({ identity: owner, spaceDid: roomSpace }),
        cold,
      );
      try {
        await coldPieces.synced();

        const fresh = await freshRoom(cold, coldPieces);

        expect(getPatternIdentityRef(await fresh.withTx().sync())?.identity)
          .toBe(releasedIdentity);
      } finally {
        await coldPieces.dispose();
        await cold.dispose();
        await coldStorage.close();
      }
    });

    it("updates the room again, to the released program with its entry edited", async () => {
      await new PieceController(roomController, room).setPattern(
        nextReleaseOf(releasedModules),
      );
      await runtime.idle();

      const updated = getPatternIdentityRef(await room.withTx().sync());
      expect(updated?.identity).not.toBe(releasedIdentity);
    });

    it("leaves the planted label on no released record once a load verifies the program", async () => {
      await runtime.patternManager.prepareSourceClosureVerification(
        roomSpace,
        [releasedIdentity],
      );

      const tx = runtime.edit();
      try {
        for (const record of records) {
          const { id } = record.getAsNormalizedFullLink();
          expect(
            (readStoredCfcMetadata(tx, { space: roomSpace, id })?.labelMap
              .entries ?? []).flatMap((entry) =>
                entry.label.confidentiality ?? []
              ),
            id,
          ).not.toContainEqual(otherMember);
        }
      } finally {
        tx.abort("planted labels read");
      }
    });
  });
});
