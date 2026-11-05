import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { parseLink } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { cellEntityIdString } from "../src/piece-helpers.ts";
import { slugIdForSpace } from "../src/slugs.ts";
import { entityIdFrom } from "../src/create-ref.ts";
import {
  isPieceRoot,
  parseSlugRedirect,
  resolveSlugReference,
  resolveSlugTargetCell,
  resolveSlugTargetInPiece,
  SlugResolutionError,
} from "../src/slug-resolution.ts";

const signer = await Identity.fromPassphrase("runner slug resolution tests");
const space = signer.did();

describe("slug resolution", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("resolves slug redirects to arbitrary cells", async () => {
    const target = runtime.getCell(
      space,
      { space, random: "slug-cell-target" },
    );
    const slugCell = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, "value-link")),
    );

    await runtime.editWithRetry((tx) => {
      const targetWithTx = target.withTx(tx);
      const slugWithTx = slugCell.withTx(tx);
      targetWithTx.set({ value: 1 });
      slugWithTx.setRawUntyped(
        targetWithTx.getAsWriteRedirectLink({ base: slugWithTx }),
      );
    });

    await slugCell.sync();
    const link = parseLink(slugCell.getRaw(), slugCell);
    expect(link?.overwrite).toBe("redirect");

    const resolved = await resolveSlugTargetCell(runtime, space, "value-link");
    expect(resolved.getAsNormalizedFullLink().id).toBe(
      target.getAsNormalizedFullLink().id,
    );
    expect(resolved.getAsNormalizedFullLink().path).toEqual([]);
    expect(resolved.get()).toEqual({ value: 1 });
  });

  it("reports missing and malformed slug documents", async () => {
    await expect(
      resolveSlugTargetCell(runtime, space, "missing"),
    ).rejects.toThrow(/Slug "missing" not found/);

    const slugCell = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, "malformed")),
    );
    await runtime.editWithRetry((tx) => {
      slugCell.withTx(tx).setRawUntyped("not a redirect");
    });

    await expect(
      resolveSlugTargetCell(runtime, space, "malformed"),
    ).rejects.toThrow(/does not contain a valid redirect/);
  });

  it("treats parseLink throws as malformed redirects (foreign-written payloads)", () => {
    // A sigil-SHAPED payload with broken internals (non-array path) makes
    // parseLink throw a generic TypeError. This runtime's own write path
    // rejects such values, but foreign clients can persist them over the
    // memory protocol — the resolver must fold the throw into the typed
    // "malformed" outcome (SlugResolutionError) instead of leaking a bare
    // TypeError past callers like the fabric chase's chain wrapping.
    const base = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, "poisoned")),
    );
    const poisoned = {
      "/": {
        "link@1": { id: "of:abc", path: "not-an-array", overwrite: "redirect" },
      },
    };
    expect(() => parseLink(poisoned, base)).toThrow(); // the hazard is real
    expect(parseSlugRedirect(poisoned, base)).toBeUndefined();
    expect(
      parseSlugRedirect("not a redirect", base),
    ).toBeUndefined();
  });

  describe("a slug that names a collection", () => {
    // A piece here is a document stamped with a `patternIdentity`, which is
    // what the resolvers read; nothing runs. The board holds its collection
    // at `names`, keyed by member name, each member a link to an item's
    // document, with two keys holding plain values for members that are no
    // piece — one of them a record whose own key names a piece. `top` points
    // at the collection, `board` at the board itself, and `plain` at a
    // document that is no piece at all.

    let board: Cell<unknown>;
    let item1: Cell<unknown>;
    let item2: Cell<unknown>;

    async function pieceDocument(
      cause: string,
      content: unknown,
    ): Promise<Cell<unknown>> {
      const cell = runtime.getCell(space, { space, random: cause });
      await runtime.editWithRetry((tx) => {
        const withTx = cell.withTx(tx);
        withTx.set(content);
        withTx.setMetaRaw(
          "patternIdentity",
          { identity: `pattern-${cause}`, symbol: "default" },
          rawMetaWriteAuthorization,
        );
      });
      return cell;
    }

    async function pointSlug(
      slug: string,
      target: Cell<unknown>,
    ): Promise<void> {
      const slugCell = runtime.getCellFromEntityId(
        space,
        entityIdFrom(slugIdForSpace(space, slug)),
      );
      await runtime.editWithRetry((tx) => {
        const slugWithTx = slugCell.withTx(tx);
        slugWithTx.setRawUntyped(
          target.withTx(tx).getAsWriteRedirectLink({ base: slugWithTx }),
        );
      });
    }

    function idOf(cell: Cell<unknown>): string {
      return cell.getAsNormalizedFullLink().id;
    }

    beforeEach(async () => {
      item1 = await pieceDocument("item-1", { title: "Glaze recipes" });
      item2 = await pieceDocument("item-2", { title: "Oven schedule" });
      // Member `4` reaches its piece through documents that are nothing but
      // links to it, the way a member stored by reference does.
      const viaLink = runtime.getCell(space, { space, random: "via-link" });
      const viaLink2 = runtime.getCell(space, { space, random: "via-link-2" });
      const plain = runtime.getCell(space, { space, random: "plain" });
      await runtime.editWithRetry((tx) => {
        viaLink2.withTx(tx).set(item2);
        viaLink.withTx(tx).set(viaLink2);
        plain.withTx(tx).set({ value: 1 });
      });
      board = await pieceDocument("board", {
        names: {
          "1": item1,
          "2": item2,
          "3": { plain: true },
          "4": viaLink,
          "5": { "6": item1 },
        },
      });
      await pointSlug("board", board);
      await pointSlug("top", board.key("names"));
      await pointSlug("plain", plain);
    });

    describe("resolveSlugReference()", () => {
      it("returns the piece and the whole path when the slug names a piece root", async () => {
        const target = await resolveSlugReference(runtime, space, "board", [
          "names",
          "1",
        ]);
        expect(idOf(target.piece)).toBe(idOf(board));
        expect(target.pathAfter).toEqual(["names", "1"]);
      });

      it("returns the member piece and the rest of the path when the slug names a collection", async () => {
        const target = await resolveSlugReference(runtime, space, "top", [
          "2",
          "title",
        ]);
        expect(idOf(target.piece)).toBe(idOf(item2));
        expect(target.piece.getAsNormalizedFullLink().path).toEqual([]);
        expect(target.pathAfter).toEqual(["title"]);
      });

      it("reads a numeric segment as the member name it denotes", async () => {
        const target = await resolveSlugReference(runtime, space, "top", [1]);
        expect(idOf(target.piece)).toBe(idOf(item1));
        expect(target.pathAfter).toEqual([]);
      });

      it("follows a member through a chain of links to the piece at its end", async () => {
        const target = await resolveSlugReference(runtime, space, "top", [
          "4",
          "title",
        ]);
        expect(idOf(target.piece)).toBe(idOf(item2));
        expect(target.pathAfter).toEqual(["title"]);
      });

      it("fails with `missing-member` naming the collection when a segment selects nothing", async () => {
        const error = await resolveSlugReference(runtime, space, "top", [
          "999",
        ]).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(SlugResolutionError);
        expect((error as SlugResolutionError).code).toBe("missing-member");
        expect((error as Error).message).toBe("no member 999 in top");
      });

      it("fails with `inside-piece` naming the containing piece when the slug names a collection and the path is empty", async () => {
        const error = await resolveSlugReference(runtime, space, "top", [])
          .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(SlugResolutionError);
        expect((error as SlugResolutionError).code).toBe("inside-piece");
        expect((error as Error).message).toContain(
          `inside piece ${cellEntityIdString(board)}`,
        );
        expect((error as Error).message).toContain("top/<name>");
      });

      it("fails with `not-piece` when the member the segment selects is no piece", async () => {
        const error = await resolveSlugReference(runtime, space, "top", ["3"])
          .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(SlugResolutionError);
        expect((error as SlugResolutionError).code).toBe("not-piece");
        expect((error as Error).message).toMatch(
          /"top\/3" does not name a piece/,
        );
      });

      it("spends one segment on the member and reads no second one as a member name", async () => {
        // Member `5` is a plain record whose own key `6` holds a piece.
        // Reading that key as a member name would let a field inside an item
        // answer to the collection's namespace, so the refusal names the one
        // segment that was spent and stops there.
        const error = await resolveSlugReference(runtime, space, "top", [
          "5",
          "6",
        ]).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(SlugResolutionError);
        expect((error as SlugResolutionError).code).toBe("not-piece");
        expect((error as Error).message).toBe(
          '"top/5" does not name a piece.',
        );
      });

      it("fails with `not-piece` for a slug to a plain document and no path", async () => {
        const error = await resolveSlugReference(runtime, space, "plain", [])
          .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(SlugResolutionError);
        expect((error as SlugResolutionError).code).toBe("not-piece");
        expect((error as Error).message).toMatch(/not a piece/);
      });
    });

    describe("resolveSlugTargetInPiece()", () => {
      it("returns the containing piece's root and the path to the target", async () => {
        const target = await resolveSlugTargetInPiece(runtime, space, "top");
        expect(idOf(target.piece)).toBe(idOf(board));
        expect(target.piece.getAsNormalizedFullLink().path).toEqual([]);
        expect(target.pathInside).toEqual(["names"]);
      });

      it("returns an empty path for a slug that names the piece itself", async () => {
        const target = await resolveSlugTargetInPiece(runtime, space, "board");
        expect(idOf(target.piece)).toBe(idOf(board));
        expect(target.pathInside).toEqual([]);
      });

      it("fails with `not-piece` for a slug to a plain document", async () => {
        const error = await resolveSlugTargetInPiece(runtime, space, "plain")
          .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(SlugResolutionError);
        expect((error as SlugResolutionError).code).toBe("not-piece");
      });
    });

    describe("isPieceRoot()", () => {
      it("returns `true` for a piece's root and `false` for a cell inside it", () => {
        expect(isPieceRoot(runtime, board)).toBe(true);
        expect(isPieceRoot(runtime, board.key("names"))).toBe(false);
      });
    });
  });
});
