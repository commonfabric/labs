/**
 * Unit tests for the cell listing. The injected controller stub is what lets
 * the listing's body run with no live runtime, no socket, and no server behind
 * it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { PiecesController } from "@commonfabric/piece/ops";

import { keysOf, listCellKeys } from "../lib/cell-listing.ts";
import type { PieceConfig } from "../lib/piece.ts";

const SPACE = "did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk";

const config: PieceConfig = {
  apiUrl: "http://localhost:8000",
  space: SPACE,
  identity: "/nonexistent/keyfile",
  piece: "fid1:listing-piece",
};

/** The value `path` names within `root`, or `undefined` where it names none. */
function valueAtPath(root: unknown, path: readonly (string | number)[]) {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

/**
 * A controller stub covering exactly what a listing read touches: the
 * runtime's server-execution posture, off here so the read waits for no
 * serving runtime, then the piece, then one of its two cells read at a path.
 * `read` collects the paths the read asked for, which is what the
 * embedded-path cases assert on.
 */
function stubController(
  cells: { result?: unknown; input?: unknown },
  read: (string | number)[][] = [],
): PiecesController {
  const cell = (root: unknown) => ({
    get: (path: (string | number)[]) => {
      read.push(path);
      return Promise.resolve(valueAtPath(root, path));
    },
  });
  return {
    runtime: { experimental: { serverExecution: false } },
    get: () =>
      Promise.resolve({
        result: cell(cells.result),
        input: cell(cells.input),
      }),
  } as unknown as PiecesController;
}

/** The seam under test: a held connection, and no address lookup behind it. */
function over(pieces: PiecesController) {
  return {
    loadPieces: () => Promise.resolve(pieces),
    loadPieceForRead: (
      _pieces: PiecesController,
      id: string,
      step: boolean,
      scope: PieceConfig["pieceScope"],
    ) => pieces.get(id, step, undefined, scope),
    resolvePieceAddress: (_pieces: PiecesController, token: string) =>
      Promise.resolve(token),
  };
}

describe("cell-listing", () => {
  describe("listCellKeys()", () => {
    it("returns the property names of the object the path names", async () => {
      const pieces = stubController({
        result: { items: { title: "a", done: false } },
      });
      expect(await listCellKeys(config, "items", {}, over(pieces)))
        .toEqual(["title", "done"]);
    });

    it("returns the indices of an array", async () => {
      const pieces = stubController({ result: { items: ["a", "b", "c"] } });
      expect(await listCellKeys(config, "items", {}, over(pieces)))
        .toEqual(["0", "1", "2"]);
    });

    it("returns nothing for a leaf", async () => {
      // `keysOf(undefined)` is empty too, so the collected read is what tells
      // an answered leaf apart from a read that never happened.

      const read: (string | number)[][] = [];
      const pieces = stubController(
        { result: { items: { title: "a" } } },
        read,
      );
      expect(await listCellKeys(config, "items/title", {}, over(pieces)))
        .toEqual([]);
      expect(read).toEqual([["items", "title"]]);
    });

    it("returns the root's keys given an empty path", async () => {
      const read: (string | number)[][] = [];
      const pieces = stubController(
        { result: { items: [], title: "a" } },
        read,
      );
      expect(await listCellKeys(config, "", {}, over(pieces)))
        .toEqual(["items", "title"]);
      expect(read).toEqual([[]]);
    });

    it("reads the arguments cell given `input`", async () => {
      const pieces = stubController({
        result: { fromResult: 1 },
        input: { fromInput: 1 },
      });
      expect(
        await listCellKeys(config, "", { input: true }, over(pieces)),
      ).toEqual(["fromInput"]);
    });

    it("reads below the path the reference already carries", async () => {
      // `mergePiecePath` puts an embedded path first, so a reference naming
      // `/of:fid1:…/items` lists that array's element rather than the root's.
      // An index typed as a word reaches the read as a number, which is what
      // `parseCellPath` makes of it.

      const read: (string | number)[][] = [];
      const pieces = stubController(
        { result: { items: [{ title: "a" }] } },
        read,
      );
      const embedded: PieceConfig = { ...config, piecePath: ["items"] };
      expect(await listCellKeys(embedded, "0", {}, over(pieces)))
        .toEqual(["title"]);
      expect(read).toEqual([["items", 0]]);
    });

    it("rejects when the connection cannot be opened", async () => {
      // An empty listing means the path names a leaf. A read that never
      // happened is the other answer, and `cf`'s callers report it.

      const failed = new Error("no route to the fabric");
      await expect(
        listCellKeys(config, "items", {}, {
          loadPieces: () => Promise.reject(failed),
        }),
      ).rejects.toThrow("no route to the fabric");
    });
  });

  describe("keysOf()", () => {
    it("returns the keys of a container and nothing for a leaf", () => {
      // A leaf yielding nothing is the correct signal that the path already
      // names a value; offering anything there would invent paths that do not
      // exist.

      expect(keysOf({ title: 1, done: 2 })).toEqual(["title", "done"]);
      expect(keysOf(["a", "b", "c"])).toEqual(["0", "1", "2"]);
      expect(keysOf([])).toEqual([]);
      expect(keysOf({})).toEqual([]);
      for (const leaf of ["text", 42, true, null, undefined]) {
        expect(keysOf(leaf)).toEqual([]);
      }
    });
  });
});
