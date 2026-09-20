import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../../../runner/src/builder/factory.ts";
import type { Cell } from "../../../runner/src/builder/types.ts";
import { pieceId } from "../../src/piece-id.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("pieces controller registry");

/** A default pattern exposing the registry surface `add()` drives. */
function defaultRegistryPattern() {
  const { commonfabric } = createBuilder();
  const { handler, pattern } = commonfabric;

  const addPiece = handler<
    { piece: Cell<unknown> },
    { pieceRegistry: Cell<Cell<unknown>[]> }
  >(
    true,
    {
      type: "object",
      properties: { pieceRegistry: { type: "array", asCell: ["cell"] } },
    },
    ({ piece }, { pieceRegistry }) => {
      pieceRegistry.push(piece);
    },
  );
  return pattern<{ pieceRegistry: Cell<unknown>[] }>(
    ({ pieceRegistry }) => ({
      pieceRegistry,
      addPiece: addPiece({ pieceRegistry }),
    }),
  );
}

function valuePattern() {
  const { commonfabric } = createBuilder();
  return commonfabric.pattern<{ value: number }>(({ value }) => ({ value }));
}

describe("pieces-controller", () => {
  describe("PiecesController", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;
    let defaultRoot: Cell<unknown>;
    let piece: Cell<unknown>;

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      pieces = new PiecesController(
        await createSession({
          identity: signer,
          spaceName: `pieces-controller-${crypto.randomUUID()}`,
        }),
        runtime,
      );
      await pieces.synced();

      defaultRoot = await pieces.runPersistent(
        defaultRegistryPattern(),
        { pieceRegistry: [] },
        "pieces-controller-default-root",
      );
      await pieces.linkDefaultPattern(defaultRoot);
      await runtime.idle();
      await pieces.synced();

      piece = await pieces.runPersistent(
        valuePattern(),
        { value: 42 },
        "pieces-controller-registered-piece",
      );
      await pieces.add([piece]);
      await runtime.idle();
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    /**
     * Replace `editWithRetry` with one that reports a commit failure without
     * running the callback, so no write happens. Returns the restore function.
     */
    function failCommits(): () => void {
      const editWithRetry = runtime.editWithRetry;
      runtime.editWithRetry = (() =>
        Promise.resolve({
          error: {
            name: "StorageTransactionAborted",
            message: "commit rejected by test",
          },
        })) as unknown as typeof runtime.editWithRetry;
      return () => {
        runtime.editWithRetry = editWithRetry;
      };
    }

    async function registeredIds(): Promise<string[]> {
      return (await pieces.getRegisteredPieces()).map((entry) => entry.id);
    }

    describe("instance members", () => {
      describe("remove()", () => {
        it("returns `true` and unregisters the piece it removes", async () => {
          const id = pieceId(piece)!;
          expect(await registeredIds()).toContain(id);

          const removed = await pieces.remove(piece);

          expect(removed).toBe(true);
          expect(await registeredIds()).not.toContain(id);
        });

        it("preserves writable registry removal when computed cell IDs are disabled", async () => {
          runtime.experimental.computedCellIds = false;
          expect(await pieces.remove(piece)).toBe(true);
          expect(await registeredIds()).not.toContain(pieceId(piece)!);
        });

        it("returns `false` for a piece that is not registered", async () => {
          await pieces.remove(piece);

          expect(await pieces.remove(piece)).toBe(false);
        });

        it("reads a bare id in the scope it is given, one id in two scopes being two documents", async () => {
          const id = pieceId(piece)!;
          expect(await registeredIds()).toContain(id);

          // The registry holds the space-scoped document. The same id under
          // `user` names another one, which was never registered.
          expect(await pieces.remove(id, "user")).toBe(false);
          expect(await registeredIds()).toContain(id);

          expect(await pieces.remove(id, "space")).toBe(true);
          expect(await registeredIds()).not.toContain(id);
        });

        it("throws when the removal cannot commit, leaving the piece registered", async () => {
          const restore = failCommits();
          try {
            await expect(pieces.remove(piece)).rejects.toThrow(
              "Removing the piece failed because storage returned " +
                "StorageTransactionAborted: commit rejected by test",
            );
          } finally {
            restore();
          }
          expect(await registeredIds()).toContain(pieceId(piece)!);
        });

        it("removes a registered default pattern and clears its link in a single commit", async () => {
          await pieces.add([defaultRoot]);
          const registry = await pieces.getPieceRegistry();

          const editWithRetry = runtime.editWithRetry;
          let commits = 0;
          runtime.editWithRetry = ((fn, maxRetries) => {
            commits += 1;
            return editWithRetry.call(runtime, fn, maxRetries);
          }) as typeof runtime.editWithRetry;
          try {
            expect(await pieces.remove(defaultRoot)).toBe(true);
          } finally {
            runtime.editWithRetry = editWithRetry;
          }

          expect(commits).toBe(1);
          expect(
            registry.get().map((entry) => pieceId(entry)),
          ).not.toContain(pieceId(defaultRoot)!);
          expect(await pieces.getDefaultPattern(false)).toBeUndefined();
        });

        it("leaves the registry and the default link intact when removing the default pattern cannot commit", async () => {
          await pieces.add([defaultRoot]);

          const restore = failCommits();
          try {
            await expect(pieces.remove(defaultRoot)).rejects.toThrow(
              "Removing the piece failed because storage returned " +
                "StorageTransactionAborted: commit rejected by test",
            );
          } finally {
            restore();
          }

          expect(await registeredIds()).toContain(pieceId(defaultRoot)!);
          expect(await pieces.getDefaultPattern(false)).toBeDefined();
        });

        it("returns `false` and leaves the default-pattern link in place for an unregistered default pattern", async () => {
          expect(await pieces.remove(defaultRoot)).toBe(false);

          expect(await pieces.getDefaultPattern(false)).toBeDefined();
        });
      });

      describe("linkDefaultPattern()", () => {
        it("throws when the link cannot commit", async () => {
          const restore = failCommits();
          try {
            await expect(pieces.linkDefaultPattern(piece)).rejects.toThrow(
              "Linking the default pattern failed because storage returned " +
                "StorageTransactionAborted: commit rejected by test",
            );
          } finally {
            restore();
          }
        });
      });

      describe("startPiece()", () => {
        it("reads a bare id in the scope it is given", async () => {
          const id = pieceId(piece)!;
          await pieces.startPiece(id, "space");

          // The same id under `user` names a document nothing was ever
          // written to, so there is no pattern there to run.
          await expect(pieces.startPiece(id, "user")).rejects.toThrow(
            "No data at cell",
          );
        });
      });

      describe("stopPiece()", () => {
        it("reads a bare id in the scope it is given", async () => {
          // Stopping a piece that is not running is a no-op either way, so
          // what the scope changes is which document is addressed. The
          // lookup is replaced to read that address back, the way
          // `failCommits()` replaces the commit.
          const addressed: unknown[] = [];
          const original = runtime
            .getCellFromEntityId as unknown as (...args: unknown[]) => unknown;
          runtime.getCellFromEntityId = ((
            space: unknown,
            entityId: unknown,
            path: unknown,
            schema: unknown,
            tx: unknown,
            scope: unknown,
          ) => {
            addressed.push(scope);
            return original.call(
              runtime,
              space,
              entityId,
              path,
              schema,
              tx,
              scope,
            );
          }) as unknown as typeof runtime.getCellFromEntityId;
          try {
            await pieces.stopPiece(pieceId(piece)!, "user");
          } finally {
            runtime.getCellFromEntityId =
              original as unknown as typeof runtime.getCellFromEntityId;
          }

          expect(addressed).toEqual(["user"]);
        });
      });

      describe("unlinkDefaultPattern()", () => {
        it("throws when the unlink cannot commit, leaving the link in place", async () => {
          const restore = failCommits();
          try {
            await expect(pieces.unlinkDefaultPattern()).rejects.toThrow(
              "Unlinking the default pattern failed because storage returned " +
                "StorageTransactionAborted: commit rejected by test",
            );
          } finally {
            restore();
          }
          expect(await pieces.getDefaultPattern(false)).toBeDefined();
        });
      });
    });
  });
});
