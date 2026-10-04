/**
 * `cf piece inspect` against a slug, over a real runtime: which piece an
 * address reaches, and which addresses fall back to reporting the cell the
 * slug points at instead of a piece. The member is a piece the controller
 * ran; the board holding the collection is a document stamped with a pattern
 * identity, which is what the resolvers read.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { pieceId, setSlugLink } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import { type Cell, createBuilder, Runtime } from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { inspectPiece } from "../lib/piece.ts";

const CONFIG = {
  apiUrl: "https://cf.dev",
  space: "collection-naming",
  identity: "~/.my.key",
  piece: "top",
};

describe("inspectPiece()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let memberId: string;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("cli inspect tests");
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const session = createSession({
      identity: signer,
      spaceDid: (await Identity.generate()).did(),
    });
    pieces = new PiecesController(session, runtime);
    await pieces.synced();
    const { commonfabric } = createBuilder();
    const memberPattern = commonfabric.pattern<{ value: number }>((
      { value },
    ) => ({ value }));
    const member = await pieces.runPersistent(memberPattern, { value: 1 }, "m");
    memberId = pieceId(member)!;
    // Member `3` is a plain record, which is what makes the two addresses
    // below differ: one reaches a piece and the other reaches no piece at all.
    const board: Cell<unknown> = runtime.getCell(
      pieces.getSpace(),
      { space: pieces.getSpace(), random: "board" },
    );
    const plain = runtime.getCell(
      pieces.getSpace(),
      { space: pieces.getSpace(), random: "plain" },
    );
    await runtime.editWithRetry((tx) => {
      plain.withTx(tx).set({ value: 1 });
      const withTx = board.withTx(tx);
      withTx.set({ names: { "2": member, "3": { plain: true } } });
      withTx.setMetaRaw(
        "patternIdentity",
        { identity: "pattern-board", symbol: "default" },
        rawMetaWriteAuthorization,
      );
    });
    await setSlugLink(pieces, "top", board.key("names"));
    await setSlugLink(pieces, "plain", plain);
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** The connection held, so the address is all that decides the answer. */
  const held = { loadPieces: () => Promise.resolve(pieces) };

  it("reports the member the path selects", async () => {
    expect((await inspectPiece({ ...CONFIG, piecePath: [2] }, held)).id)
      .toBe(memberId);
  });

  it("refuses a member that is no piece rather than reporting the collection", async () => {
    // The fallback below answers for a slug that names a cell, and a caller
    // who named a member is not asking about the cell the slug points at.
    // Reporting it would answer a question nobody put.
    await expect(inspectPiece({ ...CONFIG, piecePath: [3] }, held))
      .rejects.toThrow(/"top\/3" does not name a piece/);
  });

  it("reports the cell a slug points at when the address names no member", async () => {
    expect((await inspectPiece({ ...CONFIG, piece: "plain" }, held)).id)
      .toBe("plain");
  });
});
