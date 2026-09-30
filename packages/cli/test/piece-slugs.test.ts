/**
 * `cf piece slugs` at its three seams: the lib listing — over an index-cell
 * double for name filtering and per-row error isolation, and over a real
 * runtime for where a name points, a piece or a cell inside one — the
 * renderer's JSON and table shapes, and the command wiring.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { pieceId, setSlugLink } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import { type Cell, Runtime } from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { decode } from "@commonfabric/utils/encoding";
import { listSpaceSlugs } from "../lib/piece.ts";
import {
  listSlugsFromCommand,
  renderSlugSummaries,
} from "../commands/piece.ts";

function captureStdout(fn: () => void): string {
  let captured = "";
  const original = Deno.stdout.writeSync;
  Deno.stdout.writeSync = (data: Uint8Array): number => {
    captured += decode(data);
    return data.length;
  };
  try {
    fn();
  } finally {
    Deno.stdout.writeSync = original;
  }
  return captured;
}

const CONFIG = {
  apiUrl: "http://localhost:8000",
  identity: "/tmp/test-identity.pem",
  space: "did:key:zSlugTest",
};

describe("piece-slugs", () => {
  describe("listSpaceSlugs", () => {
    it("lists the index's names sorted, and isolates a resolution failure to its row", async () => {
      // The index cell double answers the map; everything past it is the real
      // resolution path, which this bare double cannot satisfy — so every
      // row must come back as an error row rather than the listing throwing.
      // The happy path resolves against a real runtime in
      // packages/piece/test/slug.test.ts, where resolution is real too.
      const pieces = {
        getSpace: () => CONFIG.space,
        runtime: {
          getCellFromEntityId: () => ({
            asSchema: () => ({
              pull: () =>
                Promise.resolve({ tracker: true, board: true, ghost: false }),
            }),
          }),
        },
      };

      const rows = await listSpaceSlugs(CONFIG, {
        loadPieces: () => Promise.resolve(pieces as never),
      });

      // `ghost` holds false, which is not an assignment — only `true` keys
      // are names.
      expect(rows.map((row) => row.slug)).toEqual(["board", "tracker"]);
      for (const row of rows) {
        expect(Object.hasOwn(row, "piece")).toBe(false);
        expect(typeof row.error).toBe("string");
        expect(row.error!.length).toBeGreaterThan(0);
      }
    });

    it("lists nothing for a space whose index does not exist", async () => {
      const pieces = {
        getSpace: () => CONFIG.space,
        runtime: {
          getCellFromEntityId: () => ({
            asSchema: () => ({ pull: () => Promise.resolve(undefined) }),
          }),
        },
      };

      expect(
        await listSpaceSlugs(CONFIG, {
          loadPieces: () => Promise.resolve(pieces as never),
        }),
      ).toEqual([]);
    });

    describe("over a real runtime", () => {
      // The board is a document stamped as a piece's, which is what the
      // resolution reads; nothing runs. `board` names it, and `top` names the
      // collection it keeps at `names`.

      let storageManager: ReturnType<typeof StorageManager.emulate>;
      let runtime: Runtime;
      let pieces: PiecesController;
      let board: Cell<unknown>;

      beforeEach(async () => {
        const signer = await Identity.fromPassphrase("cf piece slugs listing");
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
        board = runtime.getCell(
          pieces.getSpace(),
          { space: pieces.getSpace(), random: "board" },
        );
        await runtime.editWithRetry((tx) => {
          const withTx = board.withTx(tx);
          withTx.set({ names: {} });
          withTx.setMetaRaw(
            "patternIdentity",
            { identity: "pattern-board", symbol: "default" },
            rawMetaWriteAuthorization,
          );
        });
        await setSlugLink(pieces, "board", board);
        await setSlugLink(pieces, "top", board.key("names"));
      });

      afterEach(async () => {
        await runtime.dispose();
        await storageManager.close();
      });

      it("lists a slug into a piece with the containing piece and the path, and one to a piece with no path", async () => {
        const rows = await listSpaceSlugs(CONFIG, {
          loadPieces: () => Promise.resolve(pieces),
        });
        expect(rows).toEqual([
          { slug: "board", piece: pieceId(board) },
          { slug: "top", piece: pieceId(board), path: ["names"] },
        ]);
      });
    });
  });

  describe("renderSlugSummaries", () => {
    it("renders rows as JSON with a null piece, the path where there is one, and the error carried through", () => {
      const json = captureStdout(() =>
        renderSlugSummaries([
          { slug: "board", piece: "fid1:abc" },
          { slug: "top", piece: "fid1:abc", path: ["names"] },
          {
            slug: "broken",
            error: "redirects to a document that is not a piece",
          },
        ], true)
      );
      expect(JSON.parse(json)).toEqual([
        { slug: "board", piece: "fid1:abc" },
        { slug: "top", piece: "fid1:abc", path: ["names"] },
        {
          slug: "broken",
          piece: null,
          error: "redirects to a document that is not a piece",
        },
      ]);
    });

    it("renders a SLUG/PIECE table with `piece/path` for a slug into a piece and an error marker, and nothing when empty", () => {
      const table = captureStdout(() =>
        renderSlugSummaries([
          { slug: "board", piece: "fid1:abc" },
          { slug: "top", piece: "fid1:abc", path: ["names"] },
          { slug: "broken", error: "no longer loads" },
        ], false)
      );
      expect(table).toContain("SLUG");
      expect(table).toContain("PIECE");
      expect(table).toContain("board");
      expect(table).toContain("fid1:abc");
      expect(table).toContain("fid1:abc/names");
      expect(table).toContain("<error: no longer loads>");

      expect(captureStdout(() => renderSlugSummaries([], false))).toBe("");
    });
  });

  describe("listSlugsFromCommand", () => {
    it("hands the parsed space config to the lister and the json flag to the renderer", async () => {
      const seen: { config?: unknown; rows?: unknown; json?: boolean } = {};
      const rows = [{ slug: "board", piece: "fid1:abc" }];

      await listSlugsFromCommand(
        {
          apiUrl: CONFIG.apiUrl,
          identity: CONFIG.identity,
          space: CONFIG.space,
          json: true,
        } as never,
        {
          listSpaceSlugs: (config) => {
            seen.config = config;
            return Promise.resolve(rows);
          },
          renderSlugSummaries: (given, json) => {
            seen.rows = given;
            seen.json = json;
          },
        },
      );

      expect((seen.config as { space: string }).space).toBe(CONFIG.space);
      expect(seen.rows).toBe(rows);
      expect(seen.json).toBe(true);
    });
  });
});
