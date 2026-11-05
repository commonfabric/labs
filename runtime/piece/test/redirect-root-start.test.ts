/**
 * Opening a piece whose pattern returns a sub-pattern's result as its whole
 * result. The piece's root document then holds a redirect to the child's
 * result, and the root carries its own pattern pointer. Opening the piece with
 * a start must start the root pattern, whose nodes feed the child, rather than
 * the child the redirect leads to: starting the child alone re-derives nothing
 * the root computes, so a value the root derived from an input that changed
 * while no runtime held the piece stays as it was stored.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { createSession, Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { entityIdFrom, isLink, Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece redirect root start");

/** A root pattern that derives `label` and returns the child's result whole. */
const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "const Child = pattern<{ label: string }, { label: string }>(",
      "  ({ label }) => ({ label }),",
      ");",
      "export default pattern<{ pending: boolean }>(({ pending }) => {",
      "  const label = computed(() => pending ? 'pending' : 'done');",
      "  return Child({ label });",
      "});",
    ].join("\n"),
  }],
};

describe("redirect-root piece start", () => {
  let server: MemoryV2Server.Server;
  let space: MemorySpace;
  let writerStorage: EmulatedStorageManager;
  let writerRuntime: Runtime;
  let writerPieces: PiecesController;
  let readerStorage: EmulatedStorageManager;
  let readerRuntime: Runtime;
  let readerPieces: PiecesController;
  let pieceId: string;

  beforeEach(async () => {
    server = newLoopbackServer();
    space = (await Identity.generate()).did();
    writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writerRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: writerStorage,
    });
    writerPieces = new PiecesController(
      createSession({ identity: signer, spaceDid: space }),
      writerRuntime,
    );
    await writerPieces.synced();

    // The writer runs the piece once, storing the label `pending` derives,
    // then stops it and changes `pending` with nothing running.
    const piece = await writerPieces.create<{ label: string }>(PROGRAM, {
      input: { pending: true },
    });
    expect(await piece.result.get(["label"])).toBe("pending");
    const root = piece.getCell();
    expect(isLink(root.getRaw())).toBe(true);
    pieceId = entityRefToString(root.entityId);
    await writerRuntime.patternManager.flushCompileCacheWrites();
    await writerPieces.stopPiece(root);
    await piece.input.set(false, ["pending"]);
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

  it("re-derives what the root computes when the piece is opened with a start", async () => {
    const opened = await readerPieces.getPieceCell<{ label: string }>(
      pieceId,
      true,
    );

    expect(await opened.key("label").pull()).toBe("done");
    expect(entityRefToString(opened.entityId)).toBe(pieceId);
  });
  it("resolves a cell at a path inside the piece's document through its links", async () => {
    // The document's pattern pointer makes only its root the piece. A cell
    // at a path inside it is a slot, opened as whatever its links reach.
    const slot = readerRuntime.getCellFromEntityId(
      space,
      entityIdFrom(pieceId),
      ["label"],
    );
    await slot.sync();

    const opened = await readerPieces.getPieceCell(slot, false);

    expect(entityRefToString(opened.entityId)).not.toBe(pieceId);
  });
});
