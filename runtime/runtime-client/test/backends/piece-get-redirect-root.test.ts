/**
 * What `handlePieceGet()` starts for a piece whose pattern returns a
 * sub-pattern's result as its whole result. The piece's root document holds a
 * redirect to the child's result, as a slug document does, but it carries a
 * pattern pointer of its own, which makes it the piece rather than a name for
 * one. A shell opens a piece through this handler with `runIt`, so a root it
 * mistook for a slug was never started, and the page showed whatever the
 * store last held for the piece's view: a value the root derives from an
 * input that changed while no runtime held the piece stayed as it was stored.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { createSession, Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { PiecesController } from "@commonfabric/piece/ops";
import { entityIdFrom, isLink, Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { RequestType } from "@/protocol/mod.ts";
import { buildProcessor } from "./build-processor.ts";

const signer = await Identity.fromPassphrase(
  "runtime-client piece get redirect root",
);

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

describe("handlePieceGet() for a piece whose root redirects", () => {
  let server: MemoryV2Server.Server;
  let space: MemorySpace;
  let writerStorage: EmulatedStorageManager;
  let writerRuntime: Runtime;
  let readerStorage: EmulatedStorageManager;
  let readerRuntime: Runtime;
  let readerPieces: PiecesController;
  let pieceId: string;
  let pieceUri: URI;

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

    // The writer runs the piece once, storing the label `pending` derives,
    // then stops it and changes `pending` with nothing running.
    const piece = await writerPieces.create<{ label: string }>(PROGRAM, {
      input: { pending: true },
    });
    expect(await piece.result.get(["label"])).toBe("pending");
    const root = piece.getCell();
    expect(isLink(root.getRaw())).toBe(true);
    pieceId = entityRefToString(root.entityId);
    pieceUri = root.getAsNormalizedFullLink().id;
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

  it("starts the piece itself, so what its root derives is current", async () => {
    const processor = buildProcessor({
      runtime: readerRuntime,
      cc: readerPieces,
      space,
      identity: signer,
    });
    const response = await processor.handlePieceGet({
      type: RequestType.PieceGet,
      pieceId,
      space,
      runIt: true,
    });

    const label = readerRuntime.getCellFromEntityId<{ label: string }>(
      space,
      entityIdFrom(pieceId),
      ["label"],
    );
    expect(await label.pull()).toBe("done");
    expect(response.piece.cell).toMatchObject({ id: pieceUri, path: [] });
  });
});
