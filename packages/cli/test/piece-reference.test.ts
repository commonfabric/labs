/**
 * The CLI's half of resolving a reference whose slug names a collection: the
 * parse lets a slug's embedded path through where a handle's is refused, a
 * command that takes a piece and nothing inside it walks that path and refuses
 * what the walk leaves, and a command that reads at a path hands the whole
 * addressed path to the reference resolver and reads at what comes back. The
 * walk itself runs against a real runtime in
 * `packages/piece/test/slug.test.ts`; here it is a double, so what is pinned
 * is the plumbing around it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { PieceReference } from "@commonfabric/piece";
import type { RestoreOutcome } from "@commonfabric/piece/ops";
import { parsePieceOptions } from "../commands/piece.ts";
import { readSourcePin, runRestore } from "../lib/bulk.ts";
import {
  getCellValue,
  type PieceResolutionDeps,
  resolvePieceConfig,
} from "../lib/piece.ts";

const CONFIG = {
  apiUrl: "https://cf.dev",
  space: "common-knowledge",
  identity: "~/.my.key",
};
const HANDLE = "of:fid1:baedreiabcdefghijklmnopqrstuvwxyz0123456789";
const MEMBER = "of:fid1:baedreimemberabcdefghijklmnopqrstuvwxyz01234";

describe("piece-reference", () => {
  describe("parsePieceOptions()", () => {
    it("carries a slug's embedded path where the command takes a piece id only, and refuses a handle's", () => {
      expect(parsePieceOptions({ ...CONFIG, cell: "/top/2" })).toMatchObject({
        piece: "top",
        piecePath: [2],
      });
      expect(() => parsePieceOptions({ ...CONFIG, cell: `/${HANDLE}/items` }))
        .toThrow(/takes a piece id only/);
    });
  });

  describe("resolvePieceConfig()", () => {
    /** Deps whose reference resolver returns `result` and records its call. */
    function resolving(
      result: PieceReference,
      seen: { token?: string; path?: unknown },
    ) {
      return {
        loadPieces: () => Promise.resolve({} as never),
        resolvePieceReference: (
          _pieces: unknown,
          token: string,
          path: readonly (string | number)[],
        ) => {
          seen.token = token;
          seen.path = path;
          return Promise.resolve(result);
        },
      };
    }

    it("walks a slug's embedded path through the reference resolver and drops it from the config", async () => {
      const seen = {};
      const resolved = await resolvePieceConfig(
        { ...CONFIG, piece: "top", piecePath: [2] },
        resolving({ piece: MEMBER, pathAfter: [] }, seen),
      );
      expect(seen).toEqual({ token: "top", path: [2] });
      expect(resolved.piece).toBe(MEMBER);
      expect(Object.hasOwn(resolved, "piecePath")).toBe(false);
    });

    it("refuses the segments the walk leaves, in the parse's words", async () => {
      await expect(
        resolvePieceConfig(
          { ...CONFIG, piece: "top", piecePath: [2, "title"] },
          resolving({ piece: MEMBER, pathAfter: ["title"] }, {}),
        ),
      ).rejects.toThrow(
        /embeds a path \("title"\) but this command takes a piece id only/,
      );
    });

    it("keeps the path a cell path inside the piece an injected address resolver names", async () => {
      // An injected `resolvePieceAddress` names the piece and nothing more,
      // so the embedded path is left over and refused here.
      await expect(
        resolvePieceConfig({ ...CONFIG, piece: "top", piecePath: [2] }, {
          loadPieces: () => Promise.resolve({} as never),
          resolvePieceAddress: () => Promise.resolve(MEMBER),
        }),
      ).rejects.toThrow(/embeds a path \("2"\)/);
    });
  });

  describe("commands whose intake is a piece and nothing inside it", () => {
    // Each hands the library a piece id and no path, and the parse lets a
    // slug's embedded path through because only the walk can tell a member
    // from a cell path. So a segment the walk leaves is refused here. Dropped
    // instead, `cf piece restore --apply` would restore the whole piece the
    // address's first segment reached, saying nothing about the rest.

    const ADDRESSED = { ...CONFIG, piece: "top", piecePath: [2, "title"] };

    /** Deps whose walk reaches {@link MEMBER} and leaves `pathAfter`. */
    function walkLeaving(
      pathAfter: (string | number)[],
    ): PieceResolutionDeps {
      return {
        loadPieces: () => Promise.resolve({} as never),
        resolvePieceReference: () =>
          Promise.resolve({ piece: MEMBER, pathAfter }),
      };
    }

    const OUTCOME: RestoreOutcome = {
      piece: MEMBER,
      revisions: [],
      restored: false,
    };

    const entryPoints: ReadonlyArray<
      [string, (deps: PieceResolutionDeps) => Promise<unknown>]
    > = [
      ["readSourcePin()", (deps) => readSourcePin(ADDRESSED, deps)],
      ["runRestore()", (deps) =>
        runRestore(ADDRESSED, { apply: true }, {
          ...deps,
          restorePiece: () => Promise.resolve(OUTCOME),
        })],
    ];

    for (const [name, run] of entryPoints) {
      it(`${name} refuses the segments the walk leaves`, async () => {
        await expect(run(walkLeaving(["title"]))).rejects.toThrow(
          /embeds a path \("title"\) but this command takes a piece id only/,
        );
      });
    }

    it("runRestore() writes the piece the walk reached when it leaves nothing", async () => {
      const restored: string[] = [];
      await runRestore({ ...CONFIG, piece: "top", piecePath: [2] }, {
        apply: true,
      }, {
        ...walkLeaving([]),
        restorePiece: (_pieces, piece) => {
          restored.push(piece);
          return Promise.resolve(OUTCOME);
        },
      });
      expect(restored).toEqual([MEMBER]);
    });
  });

  describe("getCellValue()", () => {
    it("hands the whole addressed path to the reference resolver and reads at the path it returns", async () => {
      const seen: {
        token?: string;
        path?: unknown;
        got?: unknown;
        read?: unknown;
      } = {};
      const piece = {
        result: {
          get: (path: unknown) => {
            seen.read = path;
            return Promise.resolve("Oven schedule");
          },
          getCell: () => Promise.resolve({ key: () => ({ key: () => ({}) }) }),
        },
      };
      const pieces = {
        runtime: { experimental: { serverExecution: false } },
        get: (id: string) => {
          seen.got = id;
          return Promise.resolve(piece);
        },
      };

      const value = await getCellValue(
        { ...CONFIG, piece: "top", piecePath: [2] },
        [2, "title"],
        {},
        {
          loadPieces: () => Promise.resolve(pieces as never),
          loadPieceForRead: (_pieces, id) => pieces.get(id) as never,
          resolvePieceReference: (_pieces, token, path) => {
            seen.token = token;
            seen.path = path;
            return Promise.resolve({ piece: MEMBER, pathAfter: ["title"] });
          },
        },
      );

      expect(value).toBe("Oven schedule");
      expect(seen).toEqual({
        token: "top",
        path: [2, "title"],
        got: MEMBER,
        read: ["title"],
      });
    });
  });
});
