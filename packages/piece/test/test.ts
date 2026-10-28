import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { taggedHashStringOf } from "@commonfabric/data-model";

import { PiecesController } from "../src/ops/pieces-controller.ts";

describe("noop", () => {
});

describe("PiecesController.getPieceCell", () => {
  it("syncs a loaded piece before starting it", async () => {
    let pieceSynced = false;
    let startSawSyncedPiece = false;

    const piece = {
      sync: () => {
        pieceSynced = true;
        return Promise.resolve();
      },
      // A non-wrapper piece resolves to itself; get() canonicalizes the address
      // (value-link slot -> result cell) before syncing + starting.
      resolveAsCell: () => piece,
      asSchema: () => piece,
      // It carries no pattern pointer of its own, so get() resolves it.
      getAsNormalizedFullLink: () => ({ path: [] }),
      getMetaRaw: () => undefined,
    };
    const runtime = {
      userIdentityDID: "did:key:home",
      getSpaceCell: () => ({
        sync: () => Promise.resolve(),
      }),
      getCellFromEntityId: () => piece,
      // Opening a piece follows its origin before starting it; this one
      // records none.
      sourceReconciler: { reconcile: () => Promise.resolve("detached") },
      // An open waits for the pattern watcher of a piece that is already
      // running; this one is not.
      runner: {
        isRunning: () => false,
        sessionPatternPointerFor: () => undefined,
      },
      start: () => {
        startSawSyncedPiece = pieceSynced;
        return Promise.resolve(true);
      },
    };
    const pieces = new PiecesController({
      as: {} as never,
      space: "did:key:test-space" as never,
    }, runtime as never);

    await pieces.getPieceCell(taggedHashStringOf("piece-id"), true, {
      type: "object",
    });

    expect(startSawSyncedPiece).toBe(true);
  });
});
