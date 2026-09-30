import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  getPatternIdentityRef,
  type Pattern,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { patchableCell } from "../../runner/test/support/patchable-cell.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece sync pattern");

function doublePattern(): Pattern {
  return {
    argumentSchema: {
      type: "object",
      properties: {
        input: { type: "number" },
      },
    },
    resultSchema: {
      type: "object",
      properties: {
        output: { type: "number" },
      },
    },
    derivedInternalCells: [{ partialCause: "output" }],
    result: {
      output: { $alias: { partialCause: "output", path: [] } },
    },
    nodes: [
      {
        module: {
          type: "javascript",
          implementation: (input: number) => input * 2,
        },
        inputs: { $alias: { cell: "argument", path: ["input"] } },
        outputs: { $alias: { partialCause: "output", path: [] } },
      },
    ],
  };
}

describe("syncPattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });
    const session = await createSession({
      identity: signer,
      spaceName: "sync-pattern-" + crypto.randomUUID(),
    });
    pieces = new PiecesController(session, runtime);
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("resolves from the supplied pattern's entry ref without reading the piece", async () => {
    const pattern = runtime.unsafeTrustPattern(doublePattern(), {
      reason: "sync-pattern test fixture",
    });
    const ref = { identity: "sync-pattern-identity", symbol: "default" };
    runtime.patternManager.associatePatternIdentity(pattern, ref);

    // A cell that setup never touched: it carries no `patternIdentity` at all,
    // so a resolution that went through the piece could not succeed.
    const bare = patchableCell(runtime.getCell(
      pieces.getSpace(),
      "sync-pattern-bare-" + crypto.randomUUID(),
    ));
    let syncs = 0;
    const originalSync = bare.sync.bind(bare);
    bare.sync = () => {
      syncs++;
      return originalSync();
    };

    expect(await pieces.syncPattern(bare, pattern)).toBe(pattern);
    expect(syncs).toBe(0);
  });

  it("resolves from the piece's own identity metadata when no pattern is supplied", async () => {
    const pattern = runtime.unsafeTrustPattern(doublePattern(), {
      reason: "sync-pattern test fixture",
    });
    const ref = { identity: "sync-pattern-from-piece", symbol: "default" };
    runtime.patternManager.associatePatternIdentity(pattern, ref);
    const piece: Cell<{ output: number }> = await pieces.runPersistent(
      pattern,
      { input: 3 },
      undefined,
      { start: true },
    );
    expect(getPatternIdentityRef(piece)).toEqual(ref);

    // No pattern in hand: the identity has to come off the piece.
    expect(await pieces.syncPattern(piece)).toBe(pattern);
  });

  it("settles the pending writes before reading an identity that is already readable", async () => {
    const pattern = runtime.unsafeTrustPattern(doublePattern(), {
      reason: "sync-pattern test fixture",
    });
    runtime.patternManager.associatePatternIdentity(pattern, {
      identity: "sync-pattern-settle-first",
      symbol: "default",
    });
    const piece: Cell<{ output: number }> = await pieces.runPersistent(
      pattern,
      { input: 4 },
      undefined,
      { start: true },
    );
    // Readable right now, so a read-first implementation would never settle.
    expect(getPatternIdentityRef(piece)).toBeDefined();

    let settles = 0;
    const originalSynced = pieces.synced.bind(pieces);
    pieces.synced = () => {
      settles++;
      return originalSynced();
    };

    expect(await pieces.syncPattern(piece)).toBe(pattern);
    expect(settles).toBe(1);
  });

  it("throws for a piece with no pattern identity and no pattern in hand", async () => {
    const bare = runtime.getCell(
      pieces.getSpace(),
      "sync-pattern-missing-" + crypto.randomUUID(),
    );

    await expect(pieces.syncPattern(bare)).rejects.toThrow(
      /piece missing pattern identity/,
    );
  });

  it("throws for a piece with no pattern identity when the supplied pattern has no entry ref", async () => {
    const unregistered = runtime.unsafeTrustPattern(doublePattern(), {
      reason: "sync-pattern test fixture",
    });
    const bare = runtime.getCell(
      pieces.getSpace(),
      "sync-pattern-unregistered-" + crypto.randomUUID(),
    );

    await expect(pieces.syncPattern(bare, unregistered)).rejects.toThrow(
      /piece missing pattern identity/,
    );
  });
});
