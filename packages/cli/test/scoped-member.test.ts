/**
 * A collection member held through a scoped link, read and written through
 * the collection's name. Scope selects which instance of an id is addressed,
 * so the walk reaching a narrowed link is the only thing that says which cell
 * `/top/<name>` means; an address that dropped it would read and write the
 * space-wide instance of the same id instead.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { resolvePieceReference, setSlugLink } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import { type Cell, entityIdFrom, Runtime } from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { getCellValue, setCellValue } from "../lib/piece.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";
import { captureStderr } from "./utils.ts";

const CONFIG = {
  apiUrl: "https://cf.dev",
  space: "collection-naming",
  identity: "~/.my.key",
  piece: "top",
};

describe("scoped-member", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let spaceInstance: Cell<unknown>;
  let sessionInstance: Cell<unknown>;
  let memberId: string;

  /** Stamps a document as a piece's, which is what the resolvers read. */
  function stampAsPiece(
    cell: Cell<unknown>,
    tx: Parameters<
      Parameters<Runtime["editWithRetry"]>[0]
    >[0],
  ): void {
    cell.withTx(tx).setMetaRaw(
      "patternIdentity",
      { identity: "pattern-item", symbol: "default" },
      rawMetaWriteAuthorization,
    );
  }

  beforeEach(async () => {
    resetWriteReceipts();
    const signer = await Identity.fromPassphrase("cli scoped member tests");
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
    const space = pieces.getSpace();

    // One id, two instances. The board's member `2` links to the session one,
    // so the two titles are what tells the instances apart.
    spaceInstance = runtime.getCell(space, { space, random: "item" });
    memberId = spaceInstance.getAsNormalizedFullLink().id.replace(/^of:/, "");
    sessionInstance = runtime.getCellFromEntityId(
      space,
      entityIdFrom(memberId),
      [],
      undefined,
      undefined,
      "session",
    );
    const board = runtime.getCell(space, { space, random: "board" });
    await runtime.editWithRetry((tx) => {
      spaceInstance.withTx(tx).set({ title: "the space-wide instance" });
      stampAsPiece(spaceInstance, tx);
      sessionInstance.withTx(tx).set({ title: "the session instance" });
      stampAsPiece(sessionInstance, tx);
      board.withTx(tx).set({ names: { "2": sessionInstance } });
      board.withTx(tx).setMetaRaw(
        "patternIdentity",
        { identity: "pattern-board", symbol: "default" },
        rawMetaWriteAuthorization,
      );
    });
    await setSlugLink(pieces, "top", board.key("names"));
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** The connection held, so the address is all that decides the answer. */
  const held = { loadPieces: () => Promise.resolve(pieces) };

  it("reports the scope the walk reached the member through", async () => {
    expect(await resolvePieceReference(pieces, "top", ["2"])).toEqual({
      piece: memberId,
      scope: "session",
      pathAfter: [],
    });
  });

  it("reads the instance the member's link names, not the space-wide one", async () => {
    expect(await getCellValue(CONFIG, ["2", "title"], {}, held))
      .toBe("the session instance");
  });

  it("writes to the instance the member's link names", async () => {
    await captureStderr(async () => {
      await setCellValue(CONFIG, ["2", "title"], "rewritten", undefined, held);
    });
    await sessionInstance.sync();
    await spaceInstance.sync();
    expect((sessionInstance.get() as { title: string }).title)
      .toBe("rewritten");
    // The other instance of the same id is untouched, which is the whole of
    // what the scope was carrying.
    expect((spaceInstance.get() as { title: string }).title)
      .toBe("the space-wide instance");
  });
});
