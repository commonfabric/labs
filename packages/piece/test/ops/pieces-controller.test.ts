import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { pieceListSchema } from "@commonfabric/runner/schemas";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";

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

/** Compare document addresses without read projection metadata. */
function address(cell: Cell<unknown>) {
  const { space, scope, id, path } = cell.getAsNormalizedFullLink();
  return { space, scope, id, path };
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

    async function initialize(
      computedCellIds = true,
      server?: ReturnType<typeof newLoopbackServer>,
    ) {
      storageManager = server
        ? EmulatedStorageManager.connectTo(server, { as: signer })
        : StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
        experimental: { computedCellIds },
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
    }

    beforeEach(() => initialize());

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

    async function installComputedRegistry(mode: "missing" | "noop" | "throw") {
      const source = `
import { computed, handler, pattern, Writable } from "commonfabric";
const removePiece = handler<{}, {}>(() => { ${
        mode === "throw" ? 'throw new Error("removal refused");' : ""
      } });
export default pattern<{panels: Writable<Writable<unknown>[]>}>(({panels}) => ({
  pieceRegistry: computed(() => panels.get().map(piece => piece)),
  ${mode === "missing" ? "" : "removePiece: removePiece({}),"}
}));
`;
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: source }],
      }, { space: pieces.getSpace() });
      const root = await pieces.runPersistent(
        compiled,
        { panels: [piece] },
        `computed-${mode}`,
      );
      await pieces.linkDefaultPattern(root);
      await runtime.idle();
      await pieces.synced();
      return root;
    }

    async function registeredIds(): Promise<string[]> {
      return (await pieces.getRegisteredPieces()).map((entry) => entry.id);
    }

    async function computedRegistrationRoot(noop = false) {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
import { computed, handler, pattern, Writable } from "commonfabric";
const addPiece = handler<{piece: Writable<unknown>}, {panels: Writable<Writable<unknown>[]>}>(
  ({piece}, {panels}) => { ${noop ? "" : "panels.push(piece);"} }
);
export default pattern<{panels: Writable<Writable<unknown>[]>}>(({panels}) => ({
  panels,
  pieceRegistry: computed(() => panels.get().map(piece => piece)),
  addPiece: addPiece({panels}),
}));`,
        }],
      }, { space: pieces.getSpace() });
      const root = await pieces.runPersistent(
        compiled,
        { panels: [] },
        crypto.randomUUID(),
      );
      await pieces.linkDefaultPattern(root);
      const registry = root.asSchema({
        type: "object",
        required: ["pieceRegistry"],
        properties: { pieceRegistry: pieceListSchema },
      }).key("pieceRegistry");
      expect(await registry.pull()).toEqual([]);
      await runtime.idle();
      await pieces.synced();
      return { root, registry };
    }

    describe("local computed registration", () => {
      for (const computedCellIds of [true, false]) {
        it(`commits registration without starting the member with computedCellIds=${computedCellIds}`, async () => {
          await runtime.dispose();
          await storageManager.close();
          const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
          await initialize(computedCellIds, server);
          const { root, registry } = await computedRegistrationRoot();
          const member = await pieces.runPersistent(
            valuePattern(),
            { value: 7 },
            "unstarted-member",
            { start: false },
          );
          const realStart = runtime.start.bind(runtime);
          const started: unknown[] = [];
          runtime.start = ((cell, ...args) => {
            started.push(address(cell));
            return realStart(cell, ...args);
          }) as typeof runtime.start;
          try {
            await pieces.add([member]);
            expect(
              registry.get().map((cell) => address(cell.resolveAsCell())),
            )
              .toEqual([address(member)]);
            expect(started).not.toContainEqual(address(member));
            runtime.runner.stop(root);
            const readerStorage = EmulatedStorageManager.connectTo(server, {
              as: signer,
            });
            const readerRuntime = new Runtime({
              apiUrl: new URL("http://toolshed.test"),
              storageManager: readerStorage,
              experimental: { serverExecution: true, computedCellIds },
            });
            let readerStarts = 0;
            const readerStart = readerRuntime.start.bind(readerRuntime);
            readerRuntime.start = ((cell, ...args) => {
              readerStarts++;
              return readerStart(cell, ...args);
            }) as typeof readerRuntime.start;
            try {
              const reader = new PiecesController({
                as: signer,
                space: pieces.getSpace(),
              }, readerRuntime);
              const durable = await reader.getRegisteredPieces();
              expect(
                await Promise.all(
                  durable.map(async (entry) => address(await entry.getCell())),
                ),
              ).toEqual([address(member)]);
              expect(readerStarts).toBe(0);
            } finally {
              await readerRuntime.dispose();
              await readerStorage.close();
            }
          } finally {
            runtime.start = realStart;
            await runtime.dispose();
            await storageManager.close();
            await server.close();
          }
        });
      }

      for (const computedCellIds of [true, false]) {
        it(`materializes a stale computed registry in a fresh local runtime with computedCellIds=${computedCellIds}`, async () => {
          if (!computedCellIds) {
            await runtime.dispose();
            await storageManager.close();
            await initialize(false);
          }
          const { root } = await computedRegistrationRoot();
          await pieces.stopPiece(root);
          const foreign = await Identity.fromPassphrase(
            "computed-registry-foreign",
          );
          const local = runtime.getCell(pieces.getSpace(), { equal: "target" });
          const target = runtime.getCell(
            foreign.did(),
            { equal: "target" },
            undefined,
            undefined,
            "user",
          ).key("nested");
          expect(local.getAsNormalizedFullLink().id).toBe(
            target.getAsNormalizedFullLink().id,
          );
          const argument = await pieces.getArgument(root);
          const edited = await runtime.editWithRetry((tx) =>
            argument.withTx(tx).key("panels").set([local, target])
          );
          expect(edited.error).toBeUndefined();
          await pieces.synced();
          const freshRuntime = new Runtime({
            apiUrl: new URL("http://toolshed.test"),
            storageManager,
            experimental: { serverExecution: false, computedCellIds },
          });
          try {
            const fresh = new PiecesController({
              as: signer,
              space: pieces.getSpace(),
            }, freshRuntime);
            const listed = await fresh.getRegisteredPieces();
            expect(
              await Promise.all(
                listed.map(async (entry) => address(await entry.getCell())),
              ),
            )
              .toEqual([
                address(local),
                address(target),
              ]);
          } finally {
            await freshRuntime.dispose();
          }
        });
      }

      it("refuses successful handler completion when the requested full target is absent", async () => {
        await computedRegistrationRoot(true);
        await expect(pieces.add([piece])).rejects.toThrow(
          "without registering the piece",
        );
      });

      it("reads a server-executed computed registry without starting the root locally", async () => {
        await computedRegistrationRoot();
        const freshRuntime = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager,
          experimental: { serverExecution: true },
        });
        let starts = 0;
        const realStart = freshRuntime.start.bind(freshRuntime);
        freshRuntime.start = ((cell, ...args) => {
          starts++;
          return realStart(cell, ...args);
        }) as typeof freshRuntime.start;
        try {
          const fresh = new PiecesController({
            as: signer,
            space: pieces.getSpace(),
          }, freshRuntime);
          expect(await fresh.getRegisteredPieces()).toEqual([]);
          expect(starts).toBe(0);
        } finally {
          await freshRuntime.dispose();
        }
      });

      it("refuses a no-op registration despite a same-ID member in another space", async () => {
        const { root, registry } = await computedRegistrationRoot(true);
        const foreign = await Identity.fromPassphrase("registration-decoy");
        const target = runtime.getCell(pieces.getSpace(), { same: "target" });
        const decoy = runtime.getCell(foreign.did(), { same: "target" });
        expect(address(target).id).toBe(address(decoy).id);
        const argument = await pieces.getArgument(root);
        const edited = await runtime.editWithRetry((tx) =>
          argument.withTx(tx).key("panels").set([decoy])
        );
        expect(edited.error).toBeUndefined();
        await registry.pull();
        await expect(pieces.add([target])).rejects.toThrow(
          "without registering the piece",
        );
        expect(registry.get().map((cell) => address(cell.resolveAsCell())))
          .toEqual([address(decoy)]);
      });
    });

    describe("instance members", () => {
      describe("remove()", () => {
        it("refuses to unlink a computed default root through member removal", async () => {
          const root = await installComputedRegistry("noop");
          await expect(pieces.remove(root)).rejects.toThrow(
            "unlinking the root is a separate operation",
          );
          expect((await pieces.getDefaultPattern(false))?.equalLinks(root))
            .toBe(true);
          expect(await registeredIds()).toEqual([pieceId(piece)]);
        });

        it("returns false for an absent computed-registry member without changing membership", async () => {
          await installComputedRegistry("noop");
          expect(await pieces.remove(defaultRoot)).toBe(false);
          expect(await registeredIds()).toEqual([pieceId(piece)]);
        });

        for (
          const [mode, message] of [
            ["missing", "The computed registry has no removePiece action"],
            [
              "noop",
              "The removePiece action committed without unregistering the piece",
            ],
            ["throw", "Transaction was aborted"],
          ] as const
        ) {
          it(`preserves membership when the removal action is ${mode}`, async () => {
            await installComputedRegistry(mode);
            await expect(pieces.remove(piece)).rejects.toThrow(message);
            expect(await registeredIds()).toEqual([pieceId(piece)]);
          });
        }

        it("returns `true` and unregisters the piece it removes", async () => {
          const id = pieceId(piece)!;
          expect(await registeredIds()).toContain(id);

          const removed = await pieces.remove(piece);

          expect(removed).toBe(true);
          expect(await registeredIds()).not.toContain(id);
        });

        it("preserves writable registry removal when computed cell IDs are disabled", async () => {
          await runtime.dispose();
          await storageManager.close();
          await initialize(false);
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
