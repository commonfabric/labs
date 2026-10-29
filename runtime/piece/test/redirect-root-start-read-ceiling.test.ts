/**
 * Opening, under a read ceiling, a piece whose pattern returns a
 * sub-pattern's result as its whole result. Starting the piece's root
 * instantiates the child as a nested piece, and before running it the runner
 * probes whether the documents the child owns are on this replica. A
 * document whose value the ceiling withholds is still on the replica, and
 * the run's own reads of it are what the ceiling governs.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { createSession, Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { isLink, Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase(
  "piece redirect root start read ceiling",
);

/**
 * A root pattern that derives `label` and returns the result of a child
 * owning a cell labeled `writer`, which the reader's ceiling does not admit.
 */
const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, type Confidential, pattern, Writable } from 'commonfabric';",
      "const Child = pattern<{ label: string }, { label: string; held: string[] }>(",
      "  ({ label }) => {",
      "    const held = new Writable<Confidential<string[], ['writer']>>(",
      "      ['writer only'],",
      "    );",
      "    return { label, held };",
      "  },",
      ");",
      "export default pattern<{ pending: boolean }>(({ pending }) => {",
      "  const label = computed(() => pending ? 'pending' : 'done');",
      "  return Child({ label });",
      "});",
    ].join("\n"),
  }],
};

/** The CFC posture both runtimes share, as the shell's sessions run it. */
const CFC_OPTIONS = {
  cfcEnforcementMode: "enforce-strict",
  cfcFlowLabels: "persist",
} as const;

describe("pieces-controller", () => {
  let server: MemoryV2Server.Server;
  let space: MemorySpace;
  let writerStorage: EmulatedStorageManager;
  let writerRuntime: Runtime;
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
      ...CFC_OPTIONS,
    });
    const writerPieces = new PiecesController(
      createSession({ identity: signer, spaceDid: space }),
      writerRuntime,
    );
    await writerPieces.synced();

    // The writer runs the piece once, storing the child's labeled cell, then
    // stops it and changes `pending` with nothing running.
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
      cfcReadMaxConfidentiality: ["reader"],
      ...CFC_OPTIONS,
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

  describe("getPieceCell() on a piece whose root redirects", () => {
    it("starts the root when its child owns a document the read ceiling withholds", async () => {
      const opened = await readerPieces.getPieceCell<
        { label: string; held: string[] }
      >(
        pieceId,
        true,
      );

      expect(await opened.key("label").pull()).toBe("done");
      expect(entityRefToString(opened.entityId)).toBe(pieceId);
      await expect(opened.key("held").pull()).rejects.toThrow(
        /read ceiling/,
      );
    });
  });
});
