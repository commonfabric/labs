/**
 * Unit tests for `stepPiece`'s write receipt. A step runs the pattern and
 * commits what recomputation produced, so it names the space it wrote to
 * like every other write path (docs/history/plans/cli-surface-shape.md, step 8);
 * the injected controller stub is what lets the receipt be asserted
 * without a live space.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { PiecesController } from "@commonfabric/piece/ops";

import { type PieceConfig, stepPiece } from "../lib/piece.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";
import { captureStderr } from "./utils.ts";

const SPACE = "did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk";

const config: PieceConfig = {
  apiUrl: "http://localhost:8000",
  space: SPACE,
  identity: "/nonexistent/keyfile",
  piece: "fid1:step-receipt-piece",
};

// A controller stub covering exactly what stepPiece touches: get the piece
// running, pull its cell, sync, stop.
function stubController(calls: string[]): PiecesController {
  return {
    get: (id: string) => {
      calls.push(`get ${id}`);
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

describe("stepPiece", () => {
  it("emits the write receipt for the space it stepped in", async () => {
    // A step exists to run the pattern and commit what recomputation
    // produced, so it is a write path and owes the space receipt like any
    // other (docs/history/plans/cli-surface-shape.md, step 8).
    resetWriteReceipts();
    const calls: string[] = [];
    const lines = await captureStderr(() =>
      stepPiece(config, {
        loadPieces: () => Promise.resolve(stubController(calls)),
        resolvePieceAddress: (_pieces, token) => Promise.resolve(token),
      })
    );
    expect(lines).toContain(`wrote to space ${SPACE}`);
    expect(calls).toEqual([
      `get ${config.piece}`,
      "synced",
      `stop ${config.piece}`,
    ]);
  });
});
