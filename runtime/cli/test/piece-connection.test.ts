/**
 * Unit tests for the `lib/piece.ts` functions that take the connection as a
 * parameter. The piece behind the connection is a double throughout, so what
 * each function does with one — the value it writes, the piece it removes,
 * the link it makes, the payload it dispatches, the view it returns — is what
 * the assertions turn on, and no socket and no server stand behind any of it.
 *
 * Most of it needs no runtime either. `getPieceView()` is the exception: the
 * inspection it delegates to reads a cell's runtime, so that block builds one
 * over an emulated storage manager and doubles only the piece around it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { PiecesController } from "@commonfabric/piece/ops";
import { Runtime, UI } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  callPieceHandler,
  getPieceView,
  linkPieces,
  LinkValidationError,
  type PieceConfig,
  type PieceResolutionDeps,
  removePiece,
  setCellValue,
} from "../lib/piece.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";
import { captureStderr, sendThroughStandIn } from "./utils.ts";

const SPACE = "did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk";
const PIECE = "fid1:connection-piece";

/** What a resolver in these tests maps {@link PIECE} to. */
const RESOLVED_PIECE = "fid1:resolved";

const config: PieceConfig = {
  apiUrl: "http://localhost:8000",
  space: SPACE,
  identity: "/nonexistent/keyfile",
  piece: PIECE,
};

/** The seam under test: a held connection, and no address lookup behind it. */
function over(pieces: PiecesController): PieceResolutionDeps {
  return {
    loadPieces: () => Promise.resolve(pieces),
    resolvePieceAddress: (_pieces, token) => Promise.resolve(token),
  };
}

describe("piece-connection", () => {
  describe("setCellValue()", () => {
    // One write per case, so the recorded write is the whole assertion: the
    // piece it was asked for, which of that piece's two cells it landed on,
    // at what path, with what value.

    interface CellWrite {
      piece: string;
      cell: "input" | "result";
      value: unknown;
      path: (string | number)[];
    }

    function stubController(writes: CellWrite[]): PiecesController {
      return {
        get: (piece: string) => {
          const setter = (cell: "input" | "result") => ({
            set: (value: unknown, path: (string | number)[]) => {
              writes.push({ piece, cell, value, path });
              return Promise.resolve();
            },
          });
          return Promise.resolve({
            input: setter("input"),
            result: setter("result"),
          });
        },
      } as unknown as PiecesController;
    }

    /**
     * A held connection whose resolver maps the configured address to a
     * different id. Reaching the piece under that id is what says the write
     * went through the resolution rather than around it: the address in
     * `config` already carries a scheme, which the stored resolver hands back
     * untouched, so an identity resolver here would agree with skipping it.
     */
    function overResolving(pieces: PiecesController): PieceResolutionDeps {
      return {
        loadPieces: () => Promise.resolve(pieces),
        resolvePieceAddress: () => Promise.resolve(RESOLVED_PIECE),
      };
    }

    it("writes the value at the path on the resolved piece's result cell, and reports where it landed", async () => {
      resetWriteReceipts();
      const writes: CellWrite[] = [];
      let landed: unknown;
      const lines = await captureStderr(async () => {
        landed = await setCellValue(
          config,
          ["items", 0, "title"],
          "Milk",
          undefined,
          overResolving(stubController(writes)),
        );
      });
      expect(writes).toEqual([{
        piece: RESOLVED_PIECE,
        cell: "result",
        value: "Milk",
        path: ["items", 0, "title"],
      }]);
      // The receipt a caller prints names the piece written to rather than
      // the address that reached it, which is not the same thing once a
      // collection's name has spent segments getting there.
      expect(landed).toEqual({
        piece: RESOLVED_PIECE,
        path: ["items", 0, "title"],
      });
      expect(lines).toContain(`wrote to space ${SPACE}`);
    });

    it("writes to the arguments cell given `input`", async () => {
      resetWriteReceipts();
      const writes: CellWrite[] = [];
      await captureStderr(async () => {
        await setCellValue(
          config,
          ["title"],
          "Bread",
          { input: true },
          overResolving(stubController(writes)),
        );
      });
      expect(writes).toEqual([{
        piece: RESOLVED_PIECE,
        cell: "input",
        value: "Bread",
        path: ["title"],
      }]);
    });

    /**
     * A held connection whose reference resolver spends the whole addressed
     * path reaching a piece, the way a collection's name resolves a member:
     * what comes back has nothing left to address inside it.
     */
    function overCollection(pieces: PiecesController): PieceResolutionDeps {
      return {
        loadPieces: () => Promise.resolve(pieces),
        resolvePieceReference: () =>
          Promise.resolve({ piece: RESOLVED_PIECE, pathAfter: [] }),
      };
    }

    it("refuses a write that resolves to a whole cell under `refuseRootWrite`", async () => {
      // The address carries a path, so nothing before resolution can tell
      // that the write would land on a whole cell: the segments are spent
      // selecting the member. Refusing after resolution is what keeps an
      // address alone from replacing everything the member holds.
      resetWriteReceipts();
      const writes: CellWrite[] = [];
      await expect(
        setCellValue(
          config,
          ["2"],
          "Milk",
          { refuseRootWrite: true },
          overCollection(stubController(writes)),
        ),
      ).rejects.toThrow(/A path is required/);
      expect(writes).toEqual([]);
    });

    it("writes a whole cell where the caller allows a root write", async () => {
      resetWriteReceipts();
      const writes: CellWrite[] = [];
      await captureStderr(async () => {
        await setCellValue(
          config,
          ["2"],
          { title: "Milk" },
          { refuseRootWrite: false },
          overCollection(stubController(writes)),
        );
      });
      expect(writes).toEqual([{
        piece: RESOLVED_PIECE,
        cell: "result",
        value: { title: "Milk" },
        path: [],
      }]);
    });
  });

  describe("removePiece()", () => {
    function stubController(
      removed: boolean,
      calls: string[] = [],
    ): PiecesController {
      return {
        remove: (id: string) => {
          calls.push(id);
          return Promise.resolve(removed);
        },
      } as unknown as PiecesController;
    }

    it("removes the piece the address resolved to", async () => {
      resetWriteReceipts();
      const calls: string[] = [];
      const lines = await captureStderr(() =>
        removePiece(config, {
          loadPieces: () => Promise.resolve(stubController(true, calls)),
          resolvePieceAddress: () => Promise.resolve(RESOLVED_PIECE),
        })
      );
      expect(calls).toEqual([RESOLVED_PIECE]);
      expect(lines).toContain(`wrote to space ${SPACE}`);
    });

    it("throws naming the piece when the space held none", async () => {
      resetWriteReceipts();
      const lines = await captureStderr(async () => {
        await expect(removePiece(config, over(stubController(false))))
          .rejects.toThrow(`Piece "${PIECE}" not found`);
      });
      // A receipt is a claim that the space changed, and a refused removal
      // changes nothing in it.
      expect(lines).toEqual([]);
    });
  });

  describe("linkPieces()", () => {
    interface LinkCall {
      source: string;
      sourcePath: (string | number)[];
      target: string;
      targetPath: (string | number)[];
    }

    /**
     * Both endpoints carry a pattern identity, which is what the validation
     * reads to tell a piece from a cell that was merely written to, and hold
     * the values the paths are checked against.
     */
    function stubController(
      links: LinkCall[],
      cells: { source: unknown; target: unknown },
    ): PiecesController {
      const piece = (result: unknown, input: unknown) => ({
        getCell: () => ({
          getMetaRaw: () => ({ identity: "id-a", symbol: "default" }),
        }),
        result: { get: () => Promise.resolve(result) },
        input: {
          get: () => Promise.resolve(input),
          getCell: () =>
            Promise.resolve({
              getAsNormalizedFullLink: () => ({ schema: true }),
            }),
        },
      });
      return {
        get: (id: string) =>
          Promise.resolve(
            id === "fid1:source"
              ? piece(cells.source, undefined)
              : piece(undefined, cells.target),
          ),
        link: (
          source: string,
          sourcePath: (string | number)[],
          target: string,
          targetPath: (string | number)[],
        ) => {
          links.push({ source, sourcePath, target, targetPath });
          return Promise.resolve();
        },
      } as unknown as PiecesController;
    }

    const endpoints = {
      source: { items: ["a"] },
      target: { feed: null },
    };

    it("links the resolved endpoints at the paths it checked", async () => {
      resetWriteReceipts();
      const links: LinkCall[] = [];
      const lines = await captureStderr(() =>
        linkPieces(
          config,
          "source-slug",
          ["items"],
          "target-slug",
          ["feed"],
          undefined,
          {
            loadPieces: () => Promise.resolve(stubController(links, endpoints)),
            resolvePieceAddress: (_pieces, token) =>
              Promise.resolve(
                token === "source-slug" ? "fid1:source" : "fid1:target",
              ),
          },
        )
      );
      expect(links).toEqual([{
        source: "fid1:source",
        sourcePath: ["items"],
        target: "fid1:target",
        targetPath: ["feed"],
      }]);
      expect(lines).toContain(`wrote to space ${SPACE}`);
    });

    it("spends an endpoint's leading segments on the member and links what is left", async () => {
      // A collection's name reaches a link endpoint the way it reaches every
      // other address: `/top/2/items` is `items` on the piece member `2`
      // holds, so that is the path validated and the path linked.
      resetWriteReceipts();
      const links: LinkCall[] = [];
      await captureStderr(() =>
        linkPieces(
          config,
          "top",
          ["2", "items"],
          "target-slug",
          ["feed"],
          undefined,
          {
            loadPieces: () => Promise.resolve(stubController(links, endpoints)),
            resolvePieceReference: (_pieces, token, path) =>
              Promise.resolve(
                token === "top"
                  ? { piece: "fid1:source", pathAfter: path.slice(1) }
                  : { piece: "fid1:target", pathAfter: [...path] },
              ),
          },
        )
      );
      expect(links).toEqual([{
        source: "fid1:source",
        sourcePath: ["items"],
        target: "fid1:target",
        targetPath: ["feed"],
      }]);
    });

    it("throws for a path neither endpoint holds, and links nothing", async () => {
      const links: LinkCall[] = [];
      await expect(
        linkPieces(
          config,
          "fid1:source",
          ["missing"],
          "fid1:target",
          ["feed"],
          undefined,
          over(stubController(links, endpoints)),
        ),
      ).rejects.toThrow(LinkValidationError);
      expect(links).toEqual([]);
    });

    it("links a path neither endpoint holds under `allowNonExisting`", async () => {
      resetWriteReceipts();
      const links: LinkCall[] = [];
      await captureStderr(() =>
        linkPieces(
          config,
          "fid1:source",
          ["missing"],
          "fid1:target",
          ["feed"],
          { allowNonExisting: true },
          over(stubController(links, endpoints)),
        )
      );
      expect(links).toEqual([{
        source: "fid1:source",
        sourcePath: ["missing"],
        target: "fid1:target",
        targetPath: ["feed"],
      }]);
    });
  });

  describe("callPieceHandler()", () => {
    /** One dispatch onto the handler cell. */
    interface Dispatch {
      input: unknown;

      /**
       * What the send was told to file the handling under, where the call
       * named an invocation, and `undefined` where it named none.
       */
      options?: { eventId: string; session: string };
    }

    /**
     * The stream marker on the raw cell value is what classifies a name as a
     * handler, so `addItem` resolves and every other name reaches the end of
     * the resolution walk with nothing.
     */
    function stubController(sent: Dispatch[]): PiecesController {
      const handlerCell = {
        getRaw: () => ({ $stream: true }),
        get: () => ({ $stream: true }),
        send: (
          input: unknown,
          resolve: (tx: unknown) => void,
          options?: { eventId: string; session: string },
        ) => {
          sent.push({ input, ...(options !== undefined ? { options } : {}) });
          resolve({ status: () => ({ status: "done" }) });
        },
      };
      const plainCell = { getRaw: () => "Milk", get: () => "Milk" };
      const rootCell = {
        key: (name: string) => ({
          asSchemaFromLinks: () => name === "addItem" ? handlerCell : plainCell,
        }),
      };
      return {
        getSpace: () => SPACE,
        get: () =>
          Promise.resolve({
            getCell: () => ({}),
            input: { getCell: () => Promise.resolve(rootCell) },
            result: { getCell: () => Promise.resolve(rootCell) },
          }),
      } as unknown as PiecesController;
    }

    it("dispatches the payload to the named handler", async () => {
      resetWriteReceipts();
      const sent: Dispatch[] = [];
      const lines = await captureStderr(() =>
        callPieceHandler(
          config,
          "addItem",
          { title: "Milk" },
          {
            sendEvent: sendThroughStandIn,
            loadPieces: () => Promise.resolve(stubController(sent)),
            loadPiece: (pieces) => pieces.get(),
          },
        )
      );
      // No invocation was named, so no id and no session ride the send;
      // the appended hook always does.
      expect(sent).toEqual([{
        input: { title: "Milk" },
        options: { onAppended: expect.any(Function) },
      }]);
      expect(lines).toContain(`wrote to space ${SPACE}`);
    });

    it("files the handling under the invocation the caller named", async () => {
      // The id and the session decide which receipt this handling files
      // under, so a call that names one and dispatches without it has spent
      // an invocation nobody can collect.

      resetWriteReceipts();
      const sent: Dispatch[] = [];
      await captureStderr(() =>
        callPieceHandler(config, "addItem", {
          title: "Milk",
        }, {
          sendEvent: sendThroughStandIn,
          loadPieces: () => Promise.resolve(stubController(sent)),
          loadPiece: (pieces) => pieces.get(),
          invocation: { id: "inv-7", session: "sess-3" },
        })
      );
      expect(sent).toEqual([{
        input: { title: "Milk" },
        options: {
          eventId: "inv-7",
          session: "sess-3",
          onAppended: expect.any(Function),
        },
      }]);
    });

    it("reports each dispatch phase to the observer it was given", async () => {
      resetWriteReceipts();
      const sent: Dispatch[] = [];
      const phases: string[] = [];
      await captureStderr(() =>
        callPieceHandler(config, "addItem", {
          title: "Milk",
        }, {
          sendEvent: sendThroughStandIn,
          loadPieces: () => Promise.resolve(stubController(sent)),
          loadPiece: (pieces) => pieces.get(),
          invocation: { id: "inv-7", session: "sess-3" },
          // The readback reads an outcome back off the receipt, which this
          // stub does not mint; skipping it ends the call at the commit, and
          // is itself a dep that has to arrive to be honored.
          skipReadback: true,
          onPhase: (phase) => phases.push(phase),
        })
      );
      expect(phases).toEqual(["dispatched", "committed"]);
    });

    it("throws naming a verb the piece does not expose", async () => {
      const sent: Dispatch[] = [];
      await expect(
        callPieceHandler(config, "title", {}, {
          loadPieces: () => Promise.resolve(stubController(sent)),
          loadPiece: (pieces) => pieces.get(),
        }),
      ).rejects.toThrow(`Callable "title" not found on piece ${PIECE}`);
      expect(sent).toEqual([]);
    });
  });

  describe("getPieceView()", () => {
    const view = { type: "vnode", name: "div", props: {}, children: [] };

    /**
     * An inspection reads both cells and their runtime, so the stub hands out
     * real cells from an emulated storage manager; only the piece around them
     * is a double.
     */
    async function withStub(
      result: unknown,
      body: (deps: PieceResolutionDeps) => Promise<void>,
    ): Promise<void> {
      const signer = await Identity.fromPassphrase("cli piece view test");
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      try {
        const space = signer.did();
        await body({
          resolvePieceAddress: (_pieces, token) => Promise.resolve(token),
          loadPieces: () =>
            Promise.resolve({
              get: () =>
                Promise.resolve({
                  id: PIECE,
                  name: () => "Notes",
                  getPatternRef: () => Promise.resolve(undefined),
                  input: {
                    get: () => Promise.resolve({}),
                    getCell: () =>
                      Promise.resolve(runtime.getCell(space, "argument")),
                  },
                  result: {
                    get: () => Promise.resolve(result),
                    getCell: () =>
                      Promise.resolve(runtime.getCell(space, "result")),
                  },
                  readingFrom: () => Promise.resolve([]),
                  readBy: () => Promise.resolve([]),
                }),
            } as any),
        });
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    }

    it("returns the view node on the piece's result cell", async () => {
      await withStub({ title: "Notes", [UI]: view }, async (deps) => {
        expect(await getPieceView(config, deps)).toEqual(view);
      });
    });

    it("returns `undefined` for a piece that publishes no view", async () => {
      await withStub({ title: "Notes" }, async (deps) => {
        expect(await getPieceView(config, deps)).toBeUndefined();
      });
    });
  });
});
