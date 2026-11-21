/**
 * Each way a caller starts a piece on its own starts the pieces that enclose
 * it first, so the piece's handlers read what those derive now rather than
 * what they derived last. The piece here is a nested instance whose input its
 * enclosing instance derives, and the enclosing instance's input changes
 * while no runtime runs it, so only an enclosing instance that starts again
 * derives the current value.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { createSession, Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type Cell,
  getMetaLink,
  type NormalizedFullLink,
  Runtime,
  setPatternSource,
  systemPatternSource,
} from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { PiecesController } from "../src/ops/pieces-controller.ts";
import { callVerb } from "../src/verb-call.ts";

const signer = await Identity.fromPassphrase("piece open input sources");

// The enclosing instance doubles its `value`; the nested instance's `record`
// copies the doubled value it is handed into `seen`, and takes an `extra` it
// does not read.
const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, Default, handler, pattern, Stream, Writable } from 'commonfabric';",
      "",
      "type Seen = Writable<number | Default<0>>;",
      "",
      "const record = handler<unknown, { doubled?: number; seen: Seen }>(",
      "  (_event, { doubled, seen }) => {",
      "    seen.set(doubled ?? -1);",
      "  },",
      ");",
      "",
      "const recorder = pattern<",
      "  { doubled?: number; seen: Seen; extra?: number },",
      "  { record: Stream<unknown> }",
      ">(({ doubled, seen }) => ({ record: record({ doubled, seen }) }));",
      "",
      "export default pattern<",
      "  { value: number; seen?: Seen },",
      "  { doubled: number; record: Stream<unknown>; seen: number }",
      ">(({ value, seen }) => {",
      "  const doubled = computed(() => value * 2);",
      "  const nested = recorder({ doubled, seen: seen! });",
      "  return { doubled, record: nested.record, seen: seen! };",
      "});",
    ].join("\n"),
  }],
};

describe("pieces-controller", () => {
  let server: MemoryV2Server.Server;
  let space: MemorySpace;
  let writerStorage: EmulatedStorageManager;
  let writerRuntime: Runtime;
  let readerStorage: EmulatedStorageManager;
  let readerRuntime: Runtime;
  let readerPieces: PiecesController;
  let enclosingLink: NormalizedFullLink;
  let nestedLink: NormalizedFullLink;
  let streamLink: NormalizedFullLink;

  beforeEach(async () => {
    server = newLoopbackServer();
    space = (await Identity.generate()).did();
    writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writerRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: writerStorage,
    });
    const writerPieces = new PiecesController(
      createSession({ identity: signer, spaceDid: space }),
      writerRuntime,
    );
    await writerPieces.synced();

    // The writer runs the enclosing piece, then stops it and changes its input
    // with nothing running.
    const enclosing = await writerPieces.create<{ doubled: number }>(PROGRAM, {
      input: { value: 1 },
    });
    expect(await enclosing.result.get(["doubled"])).toBe(2);
    const enclosingCell = enclosing.getCell().resolveAsCell();
    enclosingLink = enclosingCell.getAsNormalizedFullLink();
    streamLink = enclosingCell.key("record").resolveAsCell()
      .getAsNormalizedFullLink();
    nestedLink = {
      ...getMetaLink(writerRuntime.getCellFromLink(streamLink), "result")!,
      path: [],
    };
    await writerRuntime.patternManager.flushCompileCacheWrites();
    await writerPieces.stopPiece(enclosing.getCell());
    await enclosing.input.set(5, ["value"]);
    await writerPieces.synced();

    readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    readerRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: readerStorage,
    });
    readerPieces = new PiecesController(
      createSession({ identity: signer, spaceDid: space }),
      readerRuntime,
    );
    await readerPieces.synced();
  });

  afterEach(async () => {
    await readerRuntime?.dispose();
    await readerStorage?.close();
    await writerRuntime?.dispose();
    await writerStorage?.close();
    await server?.close();
  });

  /** The nested piece, as the reader's runtime holds it. */
  const nested = async (): Promise<Cell<unknown>> => {
    const cell = readerRuntime.getCellFromLink(nestedLink);
    await cell.sync();
    return cell;
  };

  /** The enclosing piece, as the reader's runtime holds it. */
  const enclosing = (): Cell<unknown> =>
    readerRuntime.getCellFromLink(enclosingLink);

  /** What the nested piece's `record` recorded, as the reader reads it. */
  const seen = async (): Promise<number | undefined> => {
    const cell = readerRuntime.getCellFromLink<{ seen?: number }>({
      ...enclosingLink,
      schema: { type: "object", properties: { seen: { type: "number" } } },
    });
    return (await cell.pull())?.seen;
  };

  /** Sends the nested piece's `record` and returns what it recorded. */
  const recordThenRead = async (): Promise<number | undefined> => {
    readerRuntime.scheduler.queueEvent(streamLink, {});
    await readerRuntime.idle();
    return await seen();
  };

  it("starts the enclosing piece before the piece `startPiece()` starts", async () => {
    await readerPieces.startPiece(await nested());

    expect(await recordThenRead()).toBe(10);
  });

  it("starts the enclosing piece before the piece a link with a start starts", async () => {
    await readerPieces.link(
      entityRefToString(enclosing().entityId),
      ["doubled"],
      entityRefToString((await nested()).entityId),
      ["extra"],
      { start: true },
    );

    expect(await recordThenRead()).toBe(10);
  });

  it("starts the enclosing piece before the piece `callVerb()` calls", async () => {
    const called = await callVerb(readerRuntime, nestedLink, "record", {});
    await readerRuntime.idle();

    expect(called.status).toBe("settled");
    expect(await seen()).toBe(10);
  });

  it("follows the enclosing piece's origin before starting it, for the piece `openPiece()` opens", async () => {
    // The enclosing piece records an origin, as a piece a client installed
    // from a release does; the reader's reconciler records what it is asked
    // to follow, and follows nothing.
    {
      const tx = writerRuntime.edit();
      setPatternSource(
        writerRuntime.getCellFromLink(enclosingLink).withTx(tx),
        tx,
        systemPatternSource("system/probe/enclosing.tsx"),
      );
      expect((await tx.commit().settled).error).toBeUndefined();
      await writerRuntime.storageManager.synced();
    }
    const reconciled: string[] = [];
    readerRuntime.sourceReconciler.reconcile = (cell) => {
      reconciled.push(cell.getAsNormalizedFullLink().id);
      return Promise.resolve("current");
    };

    await readerPieces.openPiece(await nested());

    expect(reconciled).toContain(enclosingLink.id);
    expect(readerRuntime.runner.isRunning(enclosing())).toBe(true);
  });

  it("leaves the opened piece running when the enclosing piece its open started stops", async () => {
    const opened = await nested();
    await readerPieces.startPiece(opened);
    expect(readerRuntime.runner.isRunning(enclosing())).toBe(true);

    await readerPieces.stopPiece(enclosing());

    expect(readerRuntime.runner.isRunning(enclosing())).toBe(false);
    expect(readerRuntime.runner.isRunning(opened)).toBe(true);
  });
});
