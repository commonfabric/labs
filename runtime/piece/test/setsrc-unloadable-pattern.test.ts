import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";

// The manual-rescue case for a stranded piece. A piece whose stored
// `patternIdentity` resolves to nothing — the live population is the board
// space's wish-minted profile sidecars, pinned to an identity only a retired
// bundle could load — cannot take a source replacement: `setPattern` loads the
// current pattern before anything else, and that load fails on exactly the
// piece a replacement would rescue. The loaded pattern feeds only the two
// checks `dangerouslyAllowIncompatibleSchema` already waives (the
// backward-compatibility assertion and retained-link validation), so under the
// flag a failed load degrades to the stored identity ref alone, and the swap
// proceeds against a piece that cannot say what it used to run. Without the
// flag the failure stays loud and nothing moves — the flag is the entire
// difference, which is what this red/green pair pins.

const signer = await Identity.fromPassphrase("setsrc unloadable pattern");

/**
 * The stored identity of the stranded fleet: profile-create as compiled into a
 * retired bundle. Correctly shaped, so it exercises the load-by-identity miss
 * rather than an identity parser, and loadable from nothing in an emulated
 * space — the same dead end the real sidecars hit.
 */
const RETIRED_BUNDLE_IDENTITY = "T-01iegivM23BebLYqW5JKMFHVtzSyV3-gTqzl6pZT4";

/**
 * Two revisions distinguished only by `marker`, so an accepted swap is
 * observable in the piece's own output. The argument stays optional: the case
 * under test is the unloadable CURRENT pattern, and a required argument field
 * would drag in the cold-argument deferral this file is not about
 * (`setsrc-cold-argument.test.ts` owns that).
 */
function markerProgram(marker: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "interface Args { label?: string }",
        "export default pattern<Args, { marker: string }>(",
        "  () => ({",
        "    [NAME]: 'Unloadable pattern',",
        `    marker: ${JSON.stringify(marker)},`,
        "  }),",
        ");",
        "",
      ].join("\n"),
    }],
  };
}

describe("setsrc over an unloadable current pattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: await runtime.createSpace(),
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * A stopped piece in the stranded fleet's exact state: a pattern pointer
   * naming an identity this space cannot load, NO source history, and NO
   * recorded origin. Built by re-pointing a healthy piece and clearing what
   * `create` recorded, rather than by deleting artifacts: the fleet's pieces
   * were minted before source history existed, so the dangling pointer is
   * their only record of what they run. The empty history matters beyond
   * fidelity — it is what routes the transition baseline through its
   * `allowUnavailable` arm; a piece WITH history is refused there ("the
   * piece's current source is not available") whatever this flag says, and
   * that boundary is deliberate.
   */
  async function strandedPiece() {
    const piece = await pieces.create(markerProgram("v1"), { input: {} });
    await runtime.idle();
    await pieces.stopPiece(piece.getCell());
    const { error } = await runtime.editWithRetry((tx) => {
      const cell = piece.getCell().withTx(tx);
      cell.setMetaRaw("patternIdentity", {
        identity: RETIRED_BUNDLE_IDENTITY,
        symbol: "default",
      }, rawMetaWriteAuthorization);
      cell.setMetaRaw(
        "pieceSourceHistory",
        undefined,
        rawMetaWriteAuthorization,
      );
      cell.setMetaRaw("patternSource", undefined, rawMetaWriteAuthorization);
    });
    expect(
      error?.message,
      "the fixture could not re-point the pattern identity, so the cases " +
        "below would run against a loadable pattern and test nothing",
    ).toBeUndefined();
    await runtime.idle();
    expect(
      piece.getCell().getMetaRaw("pieceSourceHistory"),
      "the piece still carries source history, so this is no longer the " +
        "fleet's history-less state and the baseline would refuse for its " +
        "own reasons",
    ).toBeUndefined();
    expect(
      piece.getCell().getMetaRaw("patternSource"),
      "the piece still records an origin, so this is no longer the fleet's " +
        "detached state",
    ).toBeUndefined();
    return piece;
  }

  it("still refuses the swap without the escape hatch", async () => {
    const piece = await strandedPiece();

    await expect(piece.setPattern(markerProgram("v2"))).rejects.toThrow(
      "could not load pattern",
    );

    expect(
      getPatternIdentityRef(piece.getCell())?.identity,
      "the pointer moved despite the refusal, so the failed load was not " +
        "the guard it is supposed to be",
    ).toBe(RETIRED_BUNDLE_IDENTITY);
  });

  it("keeps refusing under the escape hatch when recorded history cannot restore the current source", async () => {
    // The flag's boundary: it waives the compatibility proofs, not the
    // source-history guarantee. A piece that RECORDED how it got its pattern
    // is entitled to a restorable current source before that source is
    // replaced, and re-pointing the identity out from under the history (the
    // clears skipped here are what strand the fleet) breaks that guarantee —
    // so the transition baseline refuses, flag or no flag.
    const piece = await pieces.create(markerProgram("v1"), { input: {} });
    await runtime.idle();
    await pieces.stopPiece(piece.getCell());
    const { error } = await runtime.editWithRetry((tx) => {
      piece.getCell().withTx(tx).setMetaRaw("patternIdentity", {
        identity: RETIRED_BUNDLE_IDENTITY,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });
    expect(error?.message).toBeUndefined();
    await runtime.idle();
    expect(
      piece.getCell().getMetaRaw("pieceSourceHistory"),
      "the piece lost its source history, so this is the fleet's " +
        "history-less state and the baseline would allow the swap",
    ).not.toBeUndefined();

    await expect(
      piece.setPattern(markerProgram("v2"), {
        dangerouslyAllowIncompatibleSchema: true,
      }),
    ).rejects.toThrow("the piece's current source is not available");

    expect(
      getPatternIdentityRef(piece.getCell())?.identity,
      "the pointer moved despite the refusal, so the flag reached past the " +
        "compatibility proofs into the source-history guarantee",
    ).toBe(RETIRED_BUNDLE_IDENTITY);
  });

  it("swaps a retained-source piece whose artifact fails to load, under the escape hatch", async () => {
    // The second rescued population: nothing was re-pointed and the source
    // closure is fully retained, but loading the artifact itself throws — a
    // compile or evaluation failure under this runtime. The transition keeps
    // its retained baseline; the stored ref only names the predecessor, so
    // the swap needs no working load of it.
    const piece = await pieces.create(markerProgram("v1"), { input: {} });
    await runtime.idle();
    await pieces.stopPiece(piece.getCell());
    const before = getPatternIdentityRef(piece.getCell());
    expect(before, "the fixture piece has no pattern pointer").toBeDefined();

    const manager = runtime.patternManager;
    const load = manager.loadPatternByIdentity.bind(manager);
    manager.loadPatternByIdentity = (
      ...args: Parameters<typeof load>
    ) =>
      args[0] === before!.identity
        ? Promise.reject(new Error("simulated artifact evaluation failure"))
        : load(...args);
    try {
      await piece.setPattern(markerProgram("v2"), {
        dangerouslyAllowIncompatibleSchema: true,
      });
    } finally {
      manager.loadPatternByIdentity = load;
    }
    await runtime.idle();

    expect(
      getPatternIdentityRef(piece.getCell())?.identity,
      "the pattern pointer still names the identity whose artifact fails " +
        "to load, so the escape hatch did not rescue the piece",
    ).not.toBe(before!.identity);

    await pieces.startPiece(piece.getCell());
    await runtime.idle();
    expect(
      (piece.getCell().getAsQueryResult() as { marker?: string }).marker,
    ).toBe("v2");
  });

  it("swaps under the escape hatch and leaves the piece runnable", async () => {
    const piece = await strandedPiece();

    await piece.setPattern(markerProgram("v2"), {
      dangerouslyAllowIncompatibleSchema: true,
    });
    await runtime.idle();

    const after = getPatternIdentityRef(piece.getCell());
    expect(
      after?.identity,
      "the pattern pointer still names the unloadable identity, so the " +
        "escape hatch did not rescue the piece",
    ).not.toBe(RETIRED_BUNDLE_IDENTITY);

    // The rescue's point is a piece that works again: start it and read the
    // output only the replacement produces.
    await pieces.startPiece(piece.getCell());
    await runtime.idle();
    expect(
      (piece.getCell().getAsQueryResult() as { marker?: string }).marker,
    ).toBe("v2");
  });
});
