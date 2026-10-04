/**
 * `cf piece set-slug`'s source resolution over a real runtime: which cell each
 * spelling of a source names, whether the piece a name lands on is stamped
 * with it, and the scope a bare slug leaves nothing to apply to. The members
 * are pieces the controller ran; the board holding the collection is a
 * document stamped with a pattern identity, which is what the resolvers read.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { pieceId, resolveSlugTarget } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  type Cell,
  createBuilder,
  Runtime,
  type URI,
} from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { setPieceSlug } from "../lib/piece.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";
import { captureStderr } from "./utils.ts";

const CONFIG = {
  apiUrl: "https://cf.dev",
  space: "collection-naming",
  identity: "~/.my.key",
};

describe("setPieceSlug()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let board: Cell<unknown>;
  let boardId: string;
  let memberId: string;

  beforeEach(async () => {
    resetWriteReceipts();
    const signer = await Identity.fromPassphrase("cli set-slug tests");
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
    board = runtime.getCell(
      pieces.getSpace(),
      { space: pieces.getSpace(), random: "board" },
    );
    await runtime.editWithRetry((tx) => {
      const withTx = board.withTx(tx);
      withTx.set({ names: { "2": member } });
      withTx.setMetaRaw(
        "patternIdentity",
        { identity: "pattern-board", symbol: "default" },
        rawMetaWriteAuthorization,
      );
    });
    boardId = pieceId(board)!;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** The `slug` meta entry on a document's root, or `undefined` for none. */
  function slugMetaOf(id: string): unknown {
    return runtime.readTx().readOrThrow({
      space: pieces.getSpace(),
      id: `of:${id}` as URI,
      scope: "space",
      path: ["slug"],
    });
  }

  /** Runs `setPieceSlug()` with the connection held, swallowing its receipt. */
  async function setSlug(
    slug: string,
    source: string,
    path: (string | number)[],
    options?: Parameters<typeof setPieceSlug>[4],
  ): Promise<void> {
    await captureStderr(() =>
      setPieceSlug(CONFIG, slug, source, path, options, {
        loadPieces: () => Promise.resolve(pieces),
      })
    );
  }

  it("names the cell a handle's path selects, and stamps no piece with the name", async () => {
    // The name is the collection's, and the collection is not a piece, so
    // there is no piece whose one `slug` entry this name could claim.
    await setSlug("top", boardId, ["names"]);

    expect(await resolveSlugTarget(pieces, "top")).toEqual({
      piece: boardId,
      pathInside: ["names"],
    });
    expect(slugMetaOf(boardId)).toBeUndefined();
  });

  it("names the member a slug's path selects, and stamps that member with the name", async () => {
    await setSlug("top", boardId, ["names"]);
    await setSlug("two", "top", ["2"]);

    expect(await resolveSlugTarget(pieces, "two")).toEqual({
      piece: memberId,
      pathInside: [],
    });
    expect(slugMetaOf(memberId)).toBe("two");
  });

  it("names whatever a bare slug points at, which is how a collection's name is aliased", async () => {
    await setSlug("top", boardId, ["names"]);
    await setSlug("board-names", "top", []);

    expect(await resolveSlugTarget(pieces, "board-names")).toEqual({
      piece: boardId,
      pathInside: ["names"],
    });
  });

  it("refuses a name that already points somewhere, naming it and the flag that takes it", async () => {
    await setSlug("top", boardId, ["names"]);

    const failure = await setSlug("top", memberId, []).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    // The whole remedy, not a substring of it: the target and the flag both
    // appear in wordings that say quite different things about what the
    // caller should do, so an assertion on either alone cannot tell them
    // apart. The target is named in the spelling the command takes as a
    // source, so pointing the name back afterwards is a paste.
    expect((failure as Error).message).toBe(
      `Slug "top" already points at /of:${boardId}/names, so assigning it ` +
        `would take that address from whoever holds it. Pass \`--force\` to ` +
        `take it anyway; that target is what to point it back at afterwards.`,
    );
    // The collection kept the name: the refused run neither took it nor
    // repointed it at the member it named.
    expect(await resolveSlugTarget(pieces, "top")).toEqual({
      piece: boardId,
      pathInside: ["names"],
    });
  });

  it("takes a name that already points somewhere when forced", async () => {
    await setSlug("top", boardId, ["names"]);

    await setSlug("top", memberId, [], { force: true });

    expect(await resolveSlugTarget(pieces, "top")).toEqual({
      piece: memberId,
      pathInside: [],
    });
  });

  it("lets a failure that is not a name being taken reach the caller unchanged", async () => {
    // Only a refusal to take a bound name is rewritten, to add the flag that
    // takes it. Everything else — a name the space will not accept, a storage
    // rejection — has to arrive as itself, or the run reports a naming
    // conflict for something that was never about the name being held.
    const failure = await setSlug("not a slug", boardId, ["names"]).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Slug must use lowercase");
    expect((failure as Error).message).not.toContain("--force");
  });

  it("refuses a scope written on a bare slug, which has no cell of its own to scope", async () => {
    await setSlug("top", boardId, ["names"]);

    await expect(
      setSlug("alias", "top", [], { sourceScope: "session" }),
    ).rejects.toThrow(/has nothing to apply to/);
    await expect(resolveSlugTarget(pieces, "alias")).rejects.toThrow(
      /not found/,
    );
  });
});
