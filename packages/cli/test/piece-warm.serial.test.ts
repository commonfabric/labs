/**
 * Unit tests for `warmPiece`, the start a long-lived caller makes so that a
 * later read of a computed value is served by a pattern running in this
 * process.
 *
 * It is the counterpart of `stepPiece` and differs in what it does around the
 * start, so the cases are about exactly that: the pattern is left running, no
 * receipt is written, and the path decides which piece runs. An injected
 * controller stub is what lets all three be asserted with no live space.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { PiecesController } from "@commonfabric/piece/ops";

import { type PieceConfig, stepPiece, warmPiece } from "../lib/piece.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";
import { captureStderr } from "./utils.ts";

const SPACE = "did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk";

const config: PieceConfig = {
  apiUrl: "http://localhost:8000",
  space: SPACE,
  identity: "/nonexistent/keyfile",
  piece: "fid1:warm-piece",
};

/** A controller stub covering exactly what `warmPiece` touches. */
function stubController(calls: string[]): PiecesController {
  return {
    get: (id: string, runIt: boolean, _schema: unknown, scope?: string) => {
      calls.push(`get ${id} ${runIt} ${scope ?? "-"}`);
      return Promise.resolve({
        getCell: () => ({ pull: () => Promise.resolve() }),
      });
    },
    synced: () => {
      calls.push("synced");
      return Promise.resolve();
    },
    stopPiece: (id: string) => {
      calls.push(`stop ${id}`);
      return Promise.resolve();
    },
  } as unknown as PiecesController;
}

describe("warmPiece()", () => {
  it("starts the piece and leaves it running", async () => {
    const calls: string[] = [];
    await warmPiece(config, [], {
      loadPieces: () => Promise.resolve(stubController(calls)),
      resolvePieceReference: (_pieces, token, path) =>
        Promise.resolve({ piece: token, pathAfter: [...path] }),
    });
    expect(calls).toEqual([`get ${config.piece} true -`]);
  });

  it("starts the piece at the scope the config names", async () => {
    const calls: string[] = [];
    await warmPiece({ ...config, pieceScope: "session" }, [], {
      loadPieces: () => Promise.resolve(stubController(calls)),
      resolvePieceReference: (_pieces, token, path) =>
        Promise.resolve({ piece: token, pathAfter: [...path] }),
    });
    expect(calls).toEqual([`get ${config.piece} true session`]);
  });

  it("starts the piece the path reached, not the one it was addressed through", async () => {
    // A walk that reaches a collection's member spends the leading segments
    // getting there, and the member is the piece whose pattern serves the
    // read.
    const calls: string[] = [];
    await warmPiece({ ...config, piece: "board" }, ["3", "title"], {
      loadPieces: () => Promise.resolve(stubController(calls)),
      resolvePieceReference: () =>
        Promise.resolve({ piece: "fid1:member", pathAfter: ["title"] }),
    });
    expect(calls).toEqual(["get fid1:member true -"]);
  });

  it("reports the piece the resolution reached, which is what a caller keys on", async () => {
    // The caller has a path and this has the piece that path resolves to.
    // Those are different things wherever a collection is walked into, and
    // only the second answers "has this piece been started".

    const warmed = await warmPiece({ ...config, piece: "board" }, ["3"], {
      loadPieces: () => Promise.resolve(stubController([])),
      resolvePieceReference: () =>
        Promise.resolve({ piece: "fid1:member", pathAfter: [] }),
    });
    expect(warmed).toEqual({ piece: "fid1:member" });
  });

  it("starts nothing the caller says is already running, and still reports it", async () => {
    // What lets a caller's memo save the start rather than only the sync in
    // front of it. The question is asked with the resolved piece, so a second
    // path into the same member finds it already running.

    const calls: string[] = [];
    const asked: string[] = [];
    const warmed = await warmPiece({ ...config, piece: "board" }, ["3"], {
      loadPieces: () => Promise.resolve(stubController(calls)),
      resolvePieceReference: () =>
        Promise.resolve({ piece: "fid1:member", pathAfter: [] }),
      alreadyRunning: (piece) => {
        asked.push(piece);
        return true;
      },
    });
    expect({ calls, asked, warmed })
      .toEqual({
        calls: [],
        asked: ["fid1:member"],
        warmed: { piece: "fid1:member" },
      });
  });

  it("starts a piece the caller says is not running", async () => {
    // The other arm, so the skip above is a decision the predicate makes
    // rather than a start nothing was going to do.

    const calls: string[] = [];
    await warmPiece({ ...config, piece: "board" }, ["3"], {
      loadPieces: () => Promise.resolve(stubController(calls)),
      resolvePieceReference: () =>
        Promise.resolve({ piece: "fid1:member", pathAfter: [] }),
      alreadyRunning: () => false,
    });
    expect(calls).toEqual(["get fid1:member true -"]);
  });

  it("writes no receipt, starting a piece being no write", async () => {
    // The empty capture is only worth something beside the call list: a warm
    // that threw, or one that started nothing, would leave stderr empty too.
    // So the case asserts that the start happened and that nothing was said
    // about it, and a mutation that removes the start reds the first half.
    resetWriteReceipts();
    const calls: string[] = [];
    const lines = await captureStderr(async () => {
      await warmPiece(config, [], {
        loadPieces: () => Promise.resolve(stubController(calls)),
        resolvePieceReference: (_pieces, token, path) =>
          Promise.resolve({ piece: token, pathAfter: [...path] }),
      });
    });
    expect(calls).toEqual([`get ${config.piece} true -`]);
    expect(lines).toEqual([]);
  });

  it("writes the receipt where a step does, so the empty one above is a difference", async () => {
    // The control for the case above. `stepPiece` runs the same stub through
    // the same capture and does say something, so an empty capture is a fact
    // about `warmPiece` rather than about the instrument.
    resetWriteReceipts();
    const calls: string[] = [];
    const lines = await captureStderr(() =>
      stepPiece(config, {
        loadPieces: () => Promise.resolve(stubController(calls)),
        resolvePieceAddress: (_pieces, token) => Promise.resolve(token),
      })
    );
    expect(lines).toEqual([`wrote to space ${SPACE}`]);
  });
});
