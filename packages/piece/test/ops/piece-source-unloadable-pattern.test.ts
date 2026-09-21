import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
  getPatternSource,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "../../src/ops/pieces-controller.ts";
import { readPieceSourceState } from "../../src/ops/piece-origin.ts";

const signer = await Identity.fromPassphrase("piece source unloadable pattern");

/**
 * A correctly shaped identity that resolves from nothing in an emulated space:
 * the load-by-identity miss a piece pinned to a retired bundle hits.
 */
const RETIRED_BUNDLE_IDENTITY = "T-01iegivM23BebLYqW5JKMFHVtzSyV3-gTqzl6pZT4";

/** The origin the fetch stub serves, and the route it serves it at. */
const ORIGIN = "system:entered.tsx";
const ORIGIN_ROUTE = "/api/patterns/entered.tsx";

/**
 * Revisions distinguished only by `version`, so the source a piece runs is
 * observable in its own output. `seed` is what a stored argument can violate.
 */
function versionProgram(
  version: string,
  seedType = "string",
): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        `export default pattern<{ seed?: ${seedType} }>(() => ({`,
        "  [NAME]: 'Unloadable pattern',",
        `  version: ${JSON.stringify(version)},`,
        "}));",
        "",
      ].join("\n"),
    }],
  };
}

describe("piece-controller", () => {
  describe("source changes over an unloadable current pattern", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;
    let served: RuntimeProgram;

    beforeEach(async () => {
      served = versionProgram("entered-v1");
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
        fetch: (input) => {
          const url = new URL(input instanceof Request ? input.url : input);
          const entry = url.pathname === ORIGIN_ROUTE
            ? served.files.find((file) => file.name === served.main)
            : undefined;
          return Promise.resolve(
            new Response(entry?.contents ?? "not found", {
              status: entry === undefined ? 404 : 200,
              headers: { "content-type": "text/typescript-jsx" },
            }),
          );
        },
      });
      pieces = new PiecesController(
        await createSession({
          identity: signer,
          spaceName: `piece-source-unloadable-pattern-${crypto.randomUUID()}`,
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
     * A stopped piece whose pattern pointer names an identity this space
     * cannot load, with no source history and no recorded origin: the state of
     * a piece minted before source history existed and then stranded by a
     * retired bundle. `keepHistory` leaves the recorded history in place, which
     * is the state the transition baseline refuses.
     */
    async function strandedPiece(
      options: { input?: Record<string, unknown>; keepHistory?: boolean } = {},
    ) {
      const piece = await pieces.create(versionProgram("v1"), {
        input: options.input ?? {},
      });
      await runtime.idle();
      await pieces.stopPiece(piece.getCell());
      const { error } = await runtime.editWithRetry((tx) => {
        const cell = piece.getCell().withTx(tx);
        cell.setMetaRaw("patternIdentity", {
          identity: RETIRED_BUNDLE_IDENTITY,
          symbol: "default",
        }, rawMetaWriteAuthorization);
        if (options.keepHistory) return;
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
      return piece;
    }

    it("returns `incompatible`, naming the pattern that does not load, and leaves the piece where it was", async () => {
      const piece = await strandedPiece();

      const result = await piece.changeSource({ kind: "repoint", url: ORIGIN });

      expect(result.status).toBe("incompatible");
      if (result.status !== "incompatible") return;
      expect(result.message).toContain(RETIRED_BUNDLE_IDENTITY);
      expect(result.message).toContain("cannot be loaded");
      expect(getPatternIdentityRef(piece.getCell())?.identity).toBe(
        RETIRED_BUNDLE_IDENTITY,
      );
      expect(getPatternSource(piece.getCell())).toBeUndefined();
    });

    it("applies a confirmed repoint, leaving the piece following the origin and running its source", async () => {
      const piece = await strandedPiece();
      const action = { kind: "repoint" as const, url: ORIGIN };
      const reviewed = await piece.changeSource(action);
      expect(reviewed.status).toBe("incompatible");
      if (reviewed.status !== "incompatible") return;

      const applied = await piece.changeSource(action, {
        confirmedChange: reviewed.prepared,
      });

      expect(applied).toEqual({ status: "applied" });
      expect(getPatternSource(piece.getCell())).toBe(ORIGIN);
      expect(getPatternIdentityRef(piece.getCell())?.identity).not.toBe(
        RETIRED_BUNDLE_IDENTITY,
      );
      await pieces.startPiece(piece.getCell());
      await runtime.idle();
      expect(await piece.result.get(["version"])).toBe("entered-v1");
      const state = await readPieceSourceState(runtime, piece.getCell());
      expect(state.history.at(-1)).toMatchObject({ operation: "repoint" });
    });

    it("records the identity a confirmed repoint displaced", async () => {
      const piece = await strandedPiece();
      const action = { kind: "repoint" as const, url: ORIGIN };
      const reviewed = await piece.changeSource(action);
      if (reviewed.status !== "incompatible") {
        throw new Error("the fixture's pattern loaded");
      }

      await piece.changeSource(action, { confirmedChange: reviewed.prepared });

      expect(piece.getCell().getMetaRaw("displacedPattern")).toMatchObject({
        identity: RETIRED_BUNDLE_IDENTITY,
        symbol: "default",
      });
    });

    it("applies a confirmed repoint over a retained source whose artifact does not load", async () => {
      // Nothing is re-pointed here and the source closure is fully retained;
      // loading the artifact is what throws, as a compile or evaluation
      // failure under this runtime would. The transition keeps its retained
      // baseline, so the source log still restores what the piece ran.

      const piece = await pieces.create(versionProgram("v1"), { input: {} });
      await runtime.idle();
      await pieces.stopPiece(piece.getCell());
      const before = getPatternIdentityRef(piece.getCell());
      expect(before, "the fixture piece has no pattern pointer").toBeDefined();
      const manager = runtime.patternManager;
      const load = manager.loadPatternByIdentity.bind(manager);
      manager.loadPatternByIdentity = (...args: Parameters<typeof load>) =>
        args[0] === before!.identity
          ? Promise.reject(new Error("simulated artifact evaluation failure"))
          : load(...args);
      const action = { kind: "repoint" as const, url: ORIGIN };
      try {
        const reviewed = await piece.changeSource(action);
        expect(reviewed.status).toBe("incompatible");
        if (reviewed.status !== "incompatible") return;
        expect(reviewed.message).toContain(before!.identity);

        expect(
          await piece.changeSource(action, {
            confirmedChange: reviewed.prepared,
          }),
        ).toEqual({ status: "applied" });
      } finally {
        manager.loadPatternByIdentity = load;
      }

      expect(getPatternSource(piece.getCell())).toBe(ORIGIN);
      const state = await readPieceSourceState(runtime, piece.getCell());
      expect(state.history.map((revision) => revision.operation)).toEqual([
        "create",
        "repoint",
      ]);
      expect(piece.getCell().getMetaRaw("displacedPattern")).toBeUndefined();
    });

    it("returns an incompatible `checkPattern()` report naming the pattern that does not load", async () => {
      const piece = await strandedPiece();

      const report = await piece.checkPattern(versionProgram("v2"));

      expect(report.compatible).toBe(false);
      expect(report.issues.schema).toContain(RETIRED_BUNDLE_IDENTITY);
      expect(report.issues.argument).toBeUndefined();
    });

    it("throws on a stored argument the origin's source refuses, confirmed or not", async () => {
      // The stored-argument refusal is the one a confirmation cannot waive:
      // the piece could not run the source at all.

      served = versionProgram("entered-v1", "number");
      const piece = await strandedPiece({ input: { seed: "not a number" } });

      await expect(
        piece.changeSource({ kind: "repoint", url: ORIGIN }),
      ).rejects.toThrow("seed");
      expect(getPatternIdentityRef(piece.getCell())?.identity).toBe(
        RETIRED_BUNDLE_IDENTITY,
      );
    });

    it("throws under confirmation when recorded history cannot restore the current source", async () => {
      // A piece that recorded how it got its pattern is entitled to a
      // restorable current source before that source is replaced, so the
      // transition baseline refuses whatever the confirmation says.

      const piece = await strandedPiece({ keepHistory: true });
      const action = { kind: "repoint" as const, url: ORIGIN };

      await expect(piece.changeSource(action)).rejects.toThrow(
        "the piece's current source is not available",
      );
      expect(getPatternIdentityRef(piece.getCell())?.identity).toBe(
        RETIRED_BUNDLE_IDENTITY,
      );
    });
  });
});
