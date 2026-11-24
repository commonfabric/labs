import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import {
  getDerivedInternalCell,
  getMetaCell,
  type NormalizedFullLink,
} from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { setResultCell } from "../src/result-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { trustPattern } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner event starts");
const space = signer.did();

const patternIdentity = {
  identity: "test-runner-event-starts",
  symbol: "default",
};

describe("runner-event-starts", () => {
  // `creator` commits each piece, and `runtime` reaches it only through the
  // shared server, so the piece is not running on `runtime` until something
  // there starts it: an event sent to its stream, or a start.

  let server: MemoryV2Server.Server;
  let creatorStorage: EmulatedStorageManager;
  let storage: EmulatedStorageManager;
  let creator: Runtime;
  let runtime: Runtime;
  let handled: unknown[];

  /** The pattern every piece runs, as `runtime` trusts it. */
  let trusted: Pattern;

  function newRuntime(storageManager: EmulatedStorageManager): Runtime {
    const made = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const pattern: Pattern = {
      argumentSchema: { type: "object", properties: {} },
      resultSchema: {
        type: "object",
        properties: { events: { type: "object" } },
      },
      derivedInternalCells: [
        { partialCause: "events", schema: { asCell: ["stream"] } },
      ],
      result: { events: { $alias: { partialCause: "events", path: [] } } },
      nodes: [
        {
          module: {
            type: "javascript",
            wrapper: "handler",
            implementation: (event: unknown) => {
              handled.push(event);
            },
          },
          inputs: {
            $event: { $alias: { partialCause: "events", path: [] } },
          },
          outputs: {},
        },
      ],
    };
    const madeTrusted = trustPattern(made, pattern);
    made.patternManager.associatePatternIdentity(madeTrusted, patternIdentity);
    if (storageManager === storage) trusted = madeTrusted;
    return made;
  }

  /**
   * Commits, on `creator`, the piece whose result document is `name`, its
   * argument linking the result documents of `sources`, the pieces its inputs
   * come from.
   */
  async function createPiece(
    name: string,
    sources: readonly string[] = [],
  ): Promise<void> {
    const tx = creator.edit();
    const resultCell = creator.getCell(space, name, undefined, tx);
    const argumentCell = getMetaCell(resultCell, "argument", tx);
    const eventsCell = getDerivedInternalCell(resultCell, {
      partialCause: "events",
    }, tx);
    resultCell.setRaw({ events: eventsCell.getAsWriteRedirectLink() });
    resultCell.setMetaRaw(
      "patternIdentity",
      patternIdentity,
      rawMetaWriteAuthorization,
    );
    resultCell.setMetaRaw(
      "argument",
      argumentCell.getAsWriteRedirectLink(),
      rawMetaWriteAuthorization,
    );
    setResultCell(eventsCell, resultCell);
    argumentCell.setRaw(
      Object.fromEntries(
        sources.map((source) => [
          source,
          creator.getCell(space, source, undefined, tx).getAsLink(),
        ]),
      ) as never,
    );
    const { error } = await tx.commit().settled;
    expect(error).toBeUndefined();
  }

  /**
   * Commits, on `creator`, a document named `name` holding only a link to the
   * result document of the piece named `piece`.
   */
  async function createLink(name: string, piece: string): Promise<void> {
    const tx = creator.edit();
    creator.getCell(space, name, undefined, tx).setRaw(
      creator.getCell(space, piece, undefined, tx).getAsLink() as never,
    );
    const { error } = await tx.commit().settled;
    expect(error).toBeUndefined();
  }

  /** The piece whose result document is `name`, as `runtime` reaches it. */
  const pieceNamed = (name: string): Cell<unknown> =>
    runtime.getCell(space, name);

  /** The link of the stream of the piece whose result document is `name`. */
  function streamOf(name: string): NormalizedFullLink {
    const tx = runtime.edit();
    const link = getDerivedInternalCell(
      runtime.getCell(space, name, undefined, tx),
      { partialCause: "events" },
      tx,
    ).getAsNormalizedFullLink();
    tx.abort("read only");
    return link;
  }

  /**
   * Sends `event` to the stream of the piece whose result document is
   * `name`, and resolves with the status of the transaction it settles on,
   * once the scheduler is idle.
   */
  async function send(name: string, event: unknown): Promise<string> {
    const settled = Promise.withResolvers<string>();
    runtime.scheduler.queueEvent(
      streamOf(name),
      event,
      undefined,
      (tx: IExtendedStorageTransaction) => settled.resolve(tx.status().status),
    );
    const status = await settled.promise;
    await runtime.idle();
    return status;
  }

  /** The result document ids `eventStartsSince(mark)` names. */
  const namedSince = (mark: number): string[] =>
    runtime.runner.eventStartsSince(mark).map((link) => link.id);

  beforeEach(() => {
    server = newSharedServer();
    creatorStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    storage = EmulatedStorageManager.connectTo(server, { as: signer });
    handled = [];
    creator = newRuntime(creatorStorage);
    runtime = newRuntime(storage);
  });

  afterEach(async () => {
    await runtime.runner.idlePieceInstantiationSettlements();
    await creator.dispose({ closeStorage: false });
    await runtime.dispose({ closeStorage: false });
    await creatorStorage.close();
    await storage.close();
    await server.close();
  });

  describe("eventStartsSince()", () => {
    it("names a piece an event's delivery started after the mark", async () => {
      await createPiece("delivered");
      const mark = runtime.runner.eventStartMark;

      expect(await send("delivered", "hello")).toBe("done");

      expect(handled).toEqual(["hello"]);
      expect(runtime.runner.isRunning(pieceNamed("delivered"))).toBe(true);
      expect(namedSince(mark)).toEqual([
        pieceNamed("delivered").getAsNormalizedFullLink().id,
      ]);
    });

    it("names no piece an event's delivery started before the mark", async () => {
      await createPiece("earlier");
      expect(await send("earlier", "hello")).toBe("done");

      expect(namedSince(runtime.runner.eventStartMark)).toEqual([]);
    });

    it("names no piece that was running before the event", async () => {
      await createPiece("running");
      expect(await runtime.start(pieceNamed("running"))).toBe(true);
      const mark = runtime.runner.eventStartMark;

      expect(await send("running", "hello")).toBe("done");

      expect(handled).toEqual(["hello"]);
      expect(namedSince(mark)).toEqual([]);
    });

    it("names no piece another start has asked for since the event's", async () => {
      await createPiece("opened");
      const mark = runtime.runner.eventStartMark;
      expect(await send("opened", "hello")).toBe("done");

      expect(await runtime.start(pieceNamed("opened"))).toBe(true);

      expect(namedSince(mark)).toEqual([]);
    });

    it("names no piece another start has asked for while that start is in flight", async () => {
      await createPiece("opening");
      const mark = runtime.runner.eventStartMark;
      expect(await send("opening", "hello")).toBe("done");

      const opening = runtime.start(pieceNamed("opening"));

      expect(namedSince(mark)).toEqual([]);
      expect(await opening).toBe(true);
    });

    it("names no piece another start has asked for through a document linking it", async () => {
      await createPiece("linked");
      await createLink("link to linked", "linked");
      const mark = runtime.runner.eventStartMark;
      expect(await send("linked", "hello")).toBe("done");

      expect(await runtime.start(pieceNamed("link to linked"))).toBe(true);

      expect(namedSince(mark)).toEqual([]);
    });

    it("names no piece a start through a linking document asked for while the event's start was in flight", async () => {
      await createPiece("raced");
      await createLink("link to raced", "raced");
      const mark = runtime.runner.eventStartMark;

      const forEvent = runtime.start(pieceNamed("raced"), { forEvent: true });
      const opened = runtime.start(pieceNamed("link to raced"));

      expect(await Promise.all([forEvent, opened])).toEqual([true, true]);
      expect(namedSince(mark)).toEqual([]);
    });

    it("names no piece a run has asked for since", async () => {
      await createPiece("run");
      const mark = runtime.runner.eventStartMark;
      expect(await send("run", "hello")).toBe("done");

      await runtime.runSynced(pieceNamed("run"), trusted, {});

      expect(namedSince(mark)).toEqual([]);
    });

    it("names the pieces an event's start started its piece's inputs from", async () => {
      await createPiece("source");
      await createPiece("owner", ["source"]);
      const mark = runtime.runner.eventStartMark;

      expect(await send("owner", "hello")).toBe("done");

      expect(namedSince(mark).sort()).toEqual(
        [pieceNamed("owner"), pieceNamed("source")].map((piece) =>
          piece.getAsNormalizedFullLink().id
        ).sort(),
      );
    });

    it("names no piece another start joined while the event's start was in flight", async () => {
      await createPiece("joined");
      const mark = runtime.runner.eventStartMark;
      // The event's start has its piece's document still to load, so the
      // second start joins it rather than finding the piece running.
      const forEvent = runtime.start(pieceNamed("joined"), { forEvent: true });
      const opened = runtime.start(pieceNamed("joined"));

      expect(await Promise.all([forEvent, opened])).toEqual([true, true]);

      expect(namedSince(mark)).toEqual([]);
      expect(runtime.runner.isRunning(pieceNamed("joined"))).toBe(true);
    });

    it("names no piece an enclosing pattern has taken as a child since", async () => {
      await createPiece("child");
      const mark = runtime.runner.eventStartMark;
      expect(await send("child", "hello")).toBe("done");

      runtime.runner.retainChild(pieceNamed("child"));

      expect(namedSince(mark)).toEqual([]);
    });

    it("names no piece stopped since", async () => {
      await createPiece("stopped");
      const mark = runtime.runner.eventStartMark;
      expect(await send("stopped", "hello")).toBe("done");

      runtime.runner.stop(pieceNamed("stopped"));

      expect(namedSince(mark)).toEqual([]);
    });
  });

  describe("releaseEventStart()", () => {
    it("stops a piece only an event's delivery started, and returns `true`", async () => {
      await createPiece("released");
      expect(await send("released", "hello")).toBe("done");
      expect(runtime.runner.isRunning(pieceNamed("released"))).toBe(true);

      expect(runtime.runner.releaseEventStart(pieceNamed("released"))).toBe(
        true,
      );

      expect(runtime.runner.isRunning(pieceNamed("released"))).toBe(false);
    });

    it("leaves a piece another start has asked for running, and returns `false`", async () => {
      await createPiece("kept");
      expect(await send("kept", "hello")).toBe("done");
      expect(await runtime.start(pieceNamed("kept"))).toBe(true);

      expect(runtime.runner.releaseEventStart(pieceNamed("kept"))).toBe(false);

      expect(runtime.runner.isRunning(pieceNamed("kept"))).toBe(true);
    });

    it("leaves a piece whose start is in flight running, and returns `false`", async () => {
      await createPiece("in-flight");
      expect(await send("in-flight", "hello")).toBe("done");
      // A start for another event's delivery, which takes nothing off what
      // may be stopped, and which has not yet settled.
      const starting = runtime.start(pieceNamed("in-flight"), {
        forEvent: true,
      });

      expect(runtime.runner.releaseEventStart(pieceNamed("in-flight"))).toBe(
        false,
      );

      expect(await starting).toBe(true);
      expect(runtime.runner.isRunning(pieceNamed("in-flight"))).toBe(true);
    });

    it("leaves a piece the scheduler holds an event for running, and returns `false`", async () => {
      await createPiece("queued");
      expect(await send("queued", "first")).toBe("done");
      const settled = Promise.withResolvers<void>();
      runtime.scheduler.queueEvent(
        streamOf("queued"),
        "second",
        undefined,
        () => settled.resolve(),
      );

      expect(runtime.runner.releaseEventStart(pieceNamed("queued"))).toBe(
        false,
      );

      await settled.promise;
      expect(handled).toEqual(["first", "second"]);
      expect(runtime.runner.isRunning(pieceNamed("queued"))).toBe(true);
    });

    it("delivers a later event to the released piece by starting it again", async () => {
      await createPiece("again");
      expect(await send("again", "first")).toBe("done");
      runtime.runner.releaseEventStart(pieceNamed("again"));
      const mark = runtime.runner.eventStartMark;

      expect(await send("again", "second")).toBe("done");

      expect(handled).toEqual(["first", "second"]);
      expect(runtime.runner.isRunning(pieceNamed("again"))).toBe(true);
      expect(namedSince(mark)).toEqual([
        pieceNamed("again").getAsNormalizedFullLink().id,
      ]);
    });
  });
});
