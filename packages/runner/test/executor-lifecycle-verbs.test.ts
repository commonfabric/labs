// The serving loop's lifecycle-verb queue (docs/features/
// server-pattern-lifecycle.md): a verb handed to the host runs on the
// space's serving runtime as a step of a wave cycle and settles once that
// cycle's wave has committed, so what the verb wrote is durable by the
// time its receipt is in hand.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import {
  LIFECYCLE_VERB_SPACE_PARKED,
  SpaceServer,
} from "../src/executor/space-server.ts";
import {
  emptyServingLoopStats,
  type ServingLoopStats,
} from "../src/executor/stats.ts";
import { waveSettlementOf } from "../src/executor/wave.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { waitUntil } from "./support/wait-until.ts";

const spaceSigner = await Identity.fromPassphrase("lifecycle verbs space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("lifecycle verbs service");
const aliceSigner = await Identity.fromPassphrase("lifecycle verbs alice");

const MARKER_CAUSE = "lifecycle-verb-marker";

describe("ExecutorHost.runLifecycleVerb", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let cleanups: Array<() => Promise<void>>;

  const servingRuntime = () => {
    const manager = EmulatedStorageManager.connectTo(server, {
      as: serviceSigner,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    return Promise.resolve({
      runtime,
      dispose: async () => {
        await runtime.dispose();
        await manager.close();
      },
    });
  };

  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: servingRuntime,
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });

  const clientRuntime = (): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await manager.close();
    });
    return runtime;
  };

  /**
   * A verb whose one write is a marker document, stamped as the loop's
   * own bookkeeping the way every served verb's writes are.
   */
  const writeMarker = (runtime: Runtime, marker: string) =>
    runtime.editWithRetry((tx) => {
      runtime.stampServerRun(tx, {
        actionId: `test-verb/${marker}`,
        kind: "bookkeeping",
      });
      runtime.getCell<{ marker: string }>(space, MARKER_CAUSE, undefined)
        .withTx(tx).set({ marker });
    });

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    cleanups = [];
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  it("activates a space nobody holds a session on, runs the verb, and resolves once its write is durable", async () => {
    host = newHost();
    const receipt = await host.runLifecycleVerb(space, {
      name: "mark",
      run: async (runtime) => {
        const outcome = await writeMarker(runtime, "served");
        expect(outcome.error).toBeUndefined();
        return "marked";
      },
    });
    expect(receipt).toBe("marked");
    expect(host.spaceServer(space)?.active).toBe(true);

    // A reader that opens its session only now sees the write: the
    // receipt came after the wave commit, not after the seal.
    const reader = clientRuntime();
    const cell = reader.getCell<{ marker: string }>(
      space,
      MARKER_CAUSE,
      undefined,
    );
    await cell.sync();
    expect(cell.get()).toEqual({ marker: "served" });
    expect(host.stats().lifecycleVerbs).toEqual({ runs: 1, failures: 0 });
  });

  it("derives a piece the verb stages after the receipt, once the verb names the piece as its demand root", async () => {
    host = newHost();
    const PATTERN = [
      "import { computed, pattern } from 'commonfabric';",
      "export default pattern<{ n: number }, { total: number }>(",
      "  ({ n }) => ({ total: computed(() => n * 7) }),",
      ");",
    ].join("\n");
    const receipt = await host.runLifecycleVerb(space, {
      name: "instantiate",
      run: async (runtime) => {
        const pattern = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: PATTERN }],
        }, { space });
        const piece = runtime.getCell<{ total: number }>(
          space,
          "verb-staged-piece",
          pattern.resultSchema,
        );
        const outcome = await runtime.editWithRetry((tx) => {
          runtime.stampServerRun(tx, {
            actionId: "test-verb/instantiate",
            kind: "bookkeeping",
          });
          void runtime.setup(tx, pattern, { n: 6 }, piece, {
            initializePieceSourceHistory: true,
          });
        });
        expect(outcome.error).toBeUndefined();
        return {
          rootId: piece.getAsNormalizedFullLink().id,
          resultSchema: pattern.resultSchema,
        };
      },
      demandRoots: (receipt) => [receipt.rootId],
    });
    expect(receipt.rootId).toMatch(/^of:/);

    // The receipt follows the creation's wave; the loop re-announces the
    // staged documents to itself and derives the piece in the cycle after.
    // A reader under the result schema, so the read reaches the computed's
    // own document, sees the value once that wave lands.
    const reader = clientRuntime();
    const cell = reader.getCell<{ total: number }>(
      space,
      "verb-staged-piece",
      receipt.resultSchema,
    );
    await cell.sync();
    await waitUntil(async () => {
      await cell.sync();
      return cell.key("total").get() === 42;
    }, "the verb-staged piece's first derivation");
  });

  it("rejects with the verb's own error and counts the failure", async () => {
    host = newHost();
    await expect(host.runLifecycleVerb(space, {
      name: "explode",
      run: () => Promise.reject(new Error("the verb refused")),
    })).rejects.toThrow("the verb refused");
    expect(host.stats().lifecycleVerbs).toEqual({ runs: 1, failures: 1 });
    // The tenure survives a failed verb: the next one runs.
    const receipt = await host.runLifecycleVerb(space, {
      name: "mark",
      run: async (runtime) => {
        await writeMarker(runtime, "after-failure");
        return "ok";
      },
    });
    expect(receipt).toBe("ok");
  });

  it("rejects when the durability read refuses, after the verb itself ran", async () => {
    host = newHost();
    let ran = false;
    await expect(host.runLifecycleVerb(space, {
      name: "unconfirmable",
      run: () => {
        ran = true;
        return Promise.resolve("receipt");
      },
      confirm: () => Promise.reject(new Error("nothing durable")),
    })).rejects.toThrow("nothing durable");
    expect(ran).toBe(true);
    expect(host.stats().lifecycleVerbs).toEqual({ runs: 1, failures: 1 });
  });

  it("runs queued verbs in arrival order, each awaited before the next", async () => {
    host = newHost();
    const order: string[] = [];
    const verb = (name: string) =>
      host!.runLifecycleVerb(space, {
        name,
        run: async (runtime) => {
          order.push(`${name}:start`);
          await writeMarker(runtime, name);
          order.push(`${name}:end`);
          return name;
        },
      });
    const receipts = await Promise.all([verb("first"), verb("second")]);
    expect(receipts).toEqual(["first", "second"]);
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  describe("a transaction stamped `directCommit`", () => {
    // A verb's transaction ordinarily seals into the cycle's wave and is
    // durable only at the wave commit. Stamped `directCommit`, it commits
    // to the store on its own, ahead of the wave, so its `commit()` result
    // is the store's verdict (docs/features/server-pattern-lifecycle.md).

    const marker = (runtime: Runtime) =>
      runtime.getCell<{ marker: string }>(space, MARKER_CAUSE, undefined);

    it("is durable when its `commit()` resolves, ahead of the wave commit", async () => {
      host = newHost();
      let sealed: {
        settlement: unknown;
        seen: { marker: string } | undefined;
      } = { settlement: null, seen: undefined };
      await host.runLifecycleVerb(space, {
        name: "mark-directly",
        run: async (runtime) => {
          const tx = runtime.edit();
          runtime.stampServerRun(tx, {
            actionId: "test-verb/mark-directly",
            kind: "bookkeeping",
            directCommit: true,
          });
          marker(runtime).withTx(tx).set({ marker: "direct" });
          runtime.prepareTxForCommit(tx);
          const outcome = await tx.commit().settled;
          expect(outcome.error).toBeUndefined();
          // Still inside the verb, so the cycle's wave has not committed:
          // a reader opened now sees the write only if it committed on
          // its own.
          const reader = clientRuntime();
          const cell = marker(reader);
          await cell.sync();
          sealed = { settlement: waveSettlementOf(tx), seen: cell.get() };
          return undefined;
        },
      });
      expect(sealed.seen).toEqual({ marker: "direct" });
      expect(sealed.settlement).toBeUndefined();
    });

    it("is refused when a document it writes moved past the seq it was stamped at", async () => {
      host = newHost();
      const outcome = await host.runLifecycleVerb(space, {
        name: "mark-late",
        run: async (runtime) => {
          const tx = runtime.edit();
          runtime.stampServerRun(tx, {
            actionId: "test-verb/mark-late",
            kind: "bookkeeping",
            directCommit: true,
          });
          marker(runtime).withTx(tx).set({ marker: "stale" });
          // A client lands its own write on the marker between the stamp
          // and the commit.
          const client = clientRuntime();
          const written = await client.editWithRetry((clientTx) => {
            marker(client).withTx(clientTx).set({ marker: "client" });
          });
          expect(written.error).toBeUndefined();
          runtime.prepareTxForCommit(tx);
          return await tx.commit().settled;
        },
      });
      expect(outcome.error?.message).toContain("direct commit rejected");
      const reader = clientRuntime();
      const cell = marker(reader);
      await cell.sync();
      expect(cell.get()).toEqual({ marker: "client" });
    });

    it("is refused when a document it read moved past the seq it read, even one it does not write", async () => {
      host = newHost();
      const guard = (runtime: Runtime) =>
        runtime.getCell<{ marker: string }>(space, "direct-guard", undefined);
      const outcome = await host.runLifecycleVerb(space, {
        name: "mark-guarded",
        run: async (runtime) => {
          await guard(runtime).sync();
          const tx = runtime.edit();
          runtime.stampServerRun(tx, {
            actionId: "test-verb/mark-guarded",
            kind: "bookkeeping",
            directCommit: true,
          });
          // The write depends on a read of another document, which a
          // client then moves before the commit.
          const seen = guard(runtime).withTx(tx).get()?.marker ?? "unset";
          marker(runtime).withTx(tx).set({ marker: `guarded by ${seen}` });
          const client = clientRuntime();
          const written = await client.editWithRetry((clientTx) => {
            guard(client).withTx(clientTx).set({ marker: "moved" });
          });
          expect(written.error).toBeUndefined();
          runtime.prepareTxForCommit(tx);
          return await tx.commit().settled;
        },
      });
      expect(outcome.error?.message).toContain("direct commit rejected");
      const reader = clientRuntime();
      const cell = marker(reader);
      await cell.sync();
      expect(cell.get()).toBeUndefined();
    });

    it("is refused at the stamp for a run that is not bookkeeping, and at the commit for a write to another space", async () => {
      host = newHost();
      const other =
        (await Identity.fromPassphrase("lifecycle verbs other space"))
          .did() as MemorySpace;
      const seen = await host.runLifecycleVerb(space, {
        name: "mark-elsewhere",
        run: async (runtime) => {
          const derivation = runtime.edit();
          let stampRefusal: string | undefined;
          try {
            runtime.stampServerRun(derivation, {
              actionId: "test-verb/derive-directly",
              kind: "derivation",
              directCommit: true,
            });
          } catch (error) {
            stampRefusal = error instanceof Error ? error.message : "";
          } finally {
            derivation.abort();
          }
          const tx = runtime.edit();
          runtime.stampServerRun(tx, {
            actionId: "test-verb/mark-elsewhere",
            kind: "bookkeeping",
            directCommit: true,
          });
          runtime.getCell<{ marker: string }>(other, MARKER_CAUSE, undefined)
            .withTx(tx).set({ marker: "elsewhere" });
          runtime.prepareTxForCommit(tx);
          return { stampRefusal, commit: await tx.commit().settled };
        },
      });
      expect(seen.stampRefusal).toContain("only a bookkeeping run");
      expect(seen.commit.error?.message).toContain(
        "may write only the serving space",
      );
    });

    const PATTERN = [
      "import { computed, pattern } from 'commonfabric';",
      "export default pattern<{ n: number }, { total: number }>(",
      "  ({ n }) => ({ total: computed(() => n * 3) }),",
      ");",
    ].join("\n");

    /** Stage a piece of `pattern` with a direct commit, in one verb. */
    const stageDirectly = (
      runtime: Runtime,
      pattern: Awaited<
        ReturnType<Runtime["patternManager"]["compilePattern"]>
      >,
      cause: string,
    ) => {
      const piece = runtime.getCell<{ total: number }>(
        space,
        cause,
        pattern.resultSchema,
      );
      return runtime.editWithRetry((tx) => {
        runtime.stampServerRun(tx, {
          actionId: `test-verb/${cause}`,
          kind: "bookkeeping",
          directCommit: true,
        });
        void runtime.setup(tx, pattern, { n: 5 }, piece, {
          initializePieceSourceHistory: true,
        });
      }).then((outcome) => ({ outcome, piece }));
    };

    it("is refused when it read state a verb of the same cycle sealed into the wave", async () => {
      // The compile's write-back of the closure seals into the cycle's
      // wave, and the setup reads that closure: pending state, which the
      // wave could still withdraw.
      host = newHost();
      const outcome = await host.runLifecycleVerb(space, {
        name: "compile-and-stage",
        run: async (runtime) => {
          const pattern = await runtime.patternManager.compilePattern({
            main: "/main.tsx",
            files: [{ name: "/main.tsx", contents: PATTERN }],
          }, { space });
          return (await stageDirectly(runtime, pattern, "staged-too-early"))
            .outcome;
        },
      });
      expect(outcome.error?.message).toContain(
        "read state the wave has not committed",
      );
    });

    it("lets a piece it stages derive in the same cycle, the derivation written over the documents the commit moved", async () => {
      // No root ensure, so nothing but the verbs' own work reaches a
      // cycle's wave. The closure is compiled in a verb of its own, durable
      // at that cycle's wave commit; the next cycle's verb stages the piece
      // directly, and the piece's first derivation, which the demand pass
      // runs once the verb has committed, seals into a wave opened ahead
      // of the commit.
      host = new ExecutorHost({
        server,
        serviceIdentity: serviceSigner.did(),
        createRuntime: servingRuntime,
        policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
        ensureSpaceRoots: false,
      });
      const compiled = await host.runLifecycleVerb(space, {
        name: "compile",
        run: async (runtime) =>
          runtime.patternManager.getArtifactEntryRef(
            await runtime.patternManager.compilePattern({
              main: "/main.tsx",
              files: [{ name: "/main.tsx", contents: PATTERN }],
            }, { space }),
          )!,
      });
      const receipt = await host.runLifecycleVerb(space, {
        name: "instantiate-directly",
        run: async (runtime) => {
          const pattern = (await runtime.patternManager.loadPatternByIdentity(
            compiled.identity,
            compiled.symbol,
            space,
            { repairCache: false },
          ))!;
          const { outcome, piece } = await stageDirectly(
            runtime,
            pattern,
            "directly-staged-piece",
          );
          expect(outcome.error).toBeUndefined();
          return {
            rootId: piece.getAsNormalizedFullLink().id,
            resultSchema: pattern.resultSchema,
          };
        },
        demandRoots: (receipt) => [receipt.rootId],
      });
      const reader = clientRuntime();
      const cell = reader.getCell<{ total: number }>(
        space,
        "directly-staged-piece",
        receipt.resultSchema,
      );
      await cell.sync();
      await waitUntil(async () => {
        await cell.sync();
        return cell.key("total").get() === 15;
      }, "the directly staged piece's first derivation");
    });
  });

  it("a SpaceServer that is not active refuses a verb with the parked message", async () => {
    const stats: ServingLoopStats = emptyServingLoopStats();
    const engine = await server.engineForSpace(space);
    const inactive = new SpaceServer({
      space,
      server,
      engine,
      serviceIdentity: serviceSigner.did(),
      createRuntime: servingRuntime,
      localSeqRef: { value: 0 },
      stats,
    });
    await expect(inactive.runLifecycleVerb({
      name: "never",
      run: () => Promise.resolve(undefined),
    })).rejects.toThrow(LIFECYCLE_VERB_SPACE_PARKED);
  });
});
