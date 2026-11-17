/**
 * Each way a caller starts a piece on its own starts the pieces its inputs
 * come from first, so the piece's handlers read what those derive now rather
 * than what they derived last. The piece here reads a producer's result
 * through its argument, as a piece wired with `cf piece link` does. The
 * producer's input changes while no runtime runs it, so only a producer that
 * starts again derives the current value.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { createSession, Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { Stream } from "@commonfabric/api";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { type Cell, Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { PiecesController } from "../src/ops/pieces-controller.ts";
import { callVerb } from "../src/verb-call.ts";

const signer = await Identity.fromPassphrase("piece open input sources");

// The producer doubles its `value`; the reader's `record` copies what its `n`
// reads into `seen`.
const SOURCE = [
  "import { computed, Default, handler, pattern, Stream, Writable } from 'commonfabric';",
  "",
  "type Seen = Writable<number | Default<0>>;",
  "",
  "export default pattern<{ value: number }, { doubled: number }>(",
  "  ({ value }) => ({ doubled: computed(() => value * 2) }),",
  ");",
  "",
  "const record = handler<unknown, { n?: number; seen: Seen }>(",
  "  (_event, { n, seen }) => {",
  "    seen.set(n ?? -1);",
  "  },",
  ");",
  "",
  "export const Reader = pattern<",
  "  { n?: number; seen?: Seen },",
  "  { record: Stream<unknown>; seen: number }",
  ">(({ n, seen }) => ({ record: record({ n, seen: seen! }), seen: seen! }));",
].join("\n");

const program = (mainExport?: string) => ({
  main: "/main.tsx",
  ...(mainExport !== undefined && { mainExport }),
  files: [{ name: "/main.tsx", contents: SOURCE }],
});

describe("open-input-sources", () => {
  let server: MemoryV2Server.Server;
  let space: MemorySpace;
  let writerStorage: EmulatedStorageManager;
  let writerRuntime: Runtime;
  let readerStorage: EmulatedStorageManager;
  let readerRuntime: Runtime;
  let readerPieces: PiecesController;
  let producerId: string;
  let readerId: string;

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

    // The writer runs both, with the reader's `n` linked to the producer's
    // `doubled`, then stops both and changes the producer's input with
    // nothing running.
    const producer = await writerPieces.create<{ doubled: number }>(
      program(),
      { input: { value: 1 } },
    );
    expect(await producer.result.get(["doubled"])).toBe(2);
    const reader = await writerPieces.create(program("Reader"), {
      input: {},
    });
    producerId = entityRefToString(producer.getCell().entityId);
    readerId = entityRefToString(reader.getCell().entityId);
    await writerPieces.link(producerId, ["doubled"], readerId, ["n"], {
      start: false,
    });
    await writerRuntime.patternManager.flushCompileCacheWrites();
    await writerPieces.stopPiece(reader.getCell());
    await writerPieces.stopPiece(producer.getCell());
    await producer.input.set(5, ["value"]);
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

  /** What the reader piece's result holds. */
  type ReaderResult = { seen?: number; record: Stream<unknown> };

  /** The reader piece's result, as the reader's runtime holds it. */
  const readerCell = async (): Promise<Cell<ReaderResult>> =>
    await readerPieces.getPieceCell<ReaderResult>(readerId, false);

  /** Sends the reader's `record` and returns what it recorded. */
  const recordThenRead = async (): Promise<number | undefined> => {
    const reader = await readerCell();
    const tx = readerRuntime.edit();
    reader.withTx(tx).key("record").send({});
    expect((await tx.commit().settled).error).toBeUndefined();
    await readerRuntime.idle();
    return await reader.key("seen").pull();
  };

  it("starts the producer before the piece `startPiece()` starts", async () => {
    await readerPieces.startPiece(readerId);

    expect(await recordThenRead()).toBe(10);
  });

  it("starts the producer before the piece a link with a start starts", async () => {
    await readerPieces.link(producerId, ["doubled"], readerId, ["n"], {
      start: true,
    });

    expect(await recordThenRead()).toBe(10);
  });

  it("starts the producer before the piece `callVerb()` calls", async () => {
    const reader = await readerCell();

    const called = await callVerb(
      readerRuntime,
      reader.getAsNormalizedFullLink(),
      "record",
      {},
    );
    await readerRuntime.idle();

    expect(called.status).toBe("settled");
    expect(await reader.key("seen").pull()).toBe(10);
  });
});
