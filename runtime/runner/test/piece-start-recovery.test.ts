import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import { createTransactionCommitReceipt } from "../src/storage/commit-receipt.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { refuseAtCommitBoundary } from "./refused-commit.ts";

const signer = await Identity.fromPassphrase("piece-start-recovery");
const space = signer.did();

/** A piece whose `count` `slots` are each its `input` times `factor`. */
function scaling(factor: number, count = 1) {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: `
        import { computed, pattern, Writable } from "commonfabric";
        export default pattern<{ input: Writable<number> }, { slots: number[] }>(
          ({ input }) => ({
            slots: [${new Array(count).fill(0).join(", ")}].map(() =>
              computed(() => input.get() * ${factor})
            ),
          }),
        );
      `,
    }],
  };
}

describe("piece-start-recovery", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let runtime: Runtime;
  let prepare: Runtime["prepareTxForCommit"];
  let readiness: Runtime["awaitCommitRetryReadiness"];

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
      experimental: { serverExecution: false },
    });
    prepare = runtime.prepareTxForCommit;
    readiness = runtime.awaitCommitRetryReadiness;
  });

  afterEach(async () => {
    runtime.prepareTxForCommit = prepare;
    runtime.awaitCommitRetryReadiness = readiness;
    await runtime.idle();
    await runtime.patternManager.flushCompileCacheWrites();
    await runtime.storageManager.synced();
    await runtime.dispose();
    await server.close();
  });

  /** Waits until the scheduler, the piece's instantiations and storage settle. */
  const settled = async () => {
    await runtime.idle();
    await runtime.runner.idlePieceInstantiationSettlements();
    await runtime.storageManager.synced();
    await runtime.idle();
  };

  /**
   * Starts a piece whose first instantiation commit is refused, and moves its
   * pointer from the pattern it runs to another while the recovery waits for
   * its catch-up. The watcher's setup for the incoming pattern settles once
   * the recovery's catch-up has ended, landing or refused as `swapLands`
   * says. With `repairOwed`, the piece's pointer names a pattern its stored
   * setup was not made by, so its start stages a setup repair.
   */
  const recoverAcrossPointerMove = async (
    { repairOwed, swapLands }: { repairOwed: boolean; swapLands: boolean },
  ) => {
    const compile = (factor: number, count?: number) =>
      runtime.patternManager.compilePattern(scaling(factor, count), { space });
    const v1 = await compile(2);
    const v2Ref = runtime.patternManager.getArtifactEntryRef(await compile(3))!;
    // A pattern with more internal cells than `v1` set up, so that the stored
    // setup covers none of the extra ones.
    const v4Ref = runtime.patternManager.getArtifactEntryRef(
      await compile(4, 2),
    )!;
    const input = runtime.getCell<number>(space, "recovery-input");
    const piece = runtime.getCell<{ slots: number[] }>(
      space,
      "recovery-scaling",
    );
    const pieceId = piece.getAsNormalizedFullLink().id;
    const seed = runtime.edit();
    input.withTx(seed).set(1);
    await runtime.setup(seed, v1, { input }, piece);
    expect((await seed.commit().settled).error).toBeUndefined();
    const movePointer = async (ref: typeof v2Ref) => {
      const move = runtime.edit();
      piece.withTx(move).setMetaRaw(
        "patternIdentity",
        ref,
        rawMetaWriteAuthorization,
      );
      expect((await move.commit().settled).error).toBeUndefined();
    };
    if (repairOwed) await movePointer(v4Ref);

    // The first instantiation commit is refused with a claim that the piece's
    // own document is absent, which recovers in every posture.
    const starts = new WeakSet<object>();
    const actionIds: string[] = [];
    const stamp = runtime.stampServerRun.bind(runtime);
    runtime.stampServerRun = ((tx, info) => {
      if (
        info.actionId.startsWith("piece-instantiate/") ||
        info.actionId.startsWith("piece-start-repair/")
      ) {
        starts.add(tx);
        actionIds.push(info.actionId.split("/")[0]);
      }
      return stamp(tx, info);
    }) as typeof runtime.stampServerRun;
    const conflict = { space, the: "application/json", of: pieceId, seq: 0 };
    const absence = {
      name: "ConflictError" as const,
      message: `stale confirmed read: ${pieceId} at seq 0 conflicted with ` +
        "seq 1",
      conflict,
      conflicts: [conflict],
      readyToRetry: () => Promise.resolve(),
    };
    let refusals = 0;
    const failures: unknown[] = [];
    runtime.pieceStartCommitFailureObserver = ({ error }) => {
      failures.push(error);
    };

    // The watcher's setup for the incoming pattern settles only once
    // `setupSettles` resolves.
    const setupStaged = Promise.withResolvers<void>();
    const setupSettles = Promise.withResolvers<void>();
    runtime.prepareTxForCommit = (tx: IExtendedStorageTransaction) => {
      if (starts.has(tx) && refusals === 0) {
        refusals += 1;
        tx.commit = () => {
          tx.abort(absence.message);
          return createTransactionCommitReceipt(
            Promise.resolve({ error: absence as never }),
          );
        };
        return;
      }
      const stagesSetup = !starts.has(tx) &&
        [...tx.getWriteDetails?.(space) ?? []].some(({ address }) =>
          address.id === pieceId && address.path[0] === "patternSetupIdentity"
        );
      if (stagesSetup) {
        if (!swapLands) {
          refuseAtCommitBoundary(tx, space, "refuse the watcher's setup");
        }
        const commit = tx.commit.bind(tx);
        tx.commit = (...args) => {
          const receipt = commit(...args);
          setupStaged.resolve();
          return Object.create(receipt, {
            settled: {
              value: setupSettles.promise.then(() => receipt.settled),
            },
          });
        };
      }
      prepare.call(runtime, tx);
    };

    // The catch-up holds until `caughtUp` resolves.
    const catchingUp = Promise.withResolvers<void>();
    const caughtUp = Promise.withResolvers<void>();
    const catchUpEnded = Promise.withResolvers<void>();
    runtime.awaitCommitRetryReadiness = async (...args) => {
      catchingUp.resolve();
      await caughtUp.promise;
      const unloaded = await readiness.apply(runtime, args);
      catchUpEnded.resolve();
      return unloaded;
    };

    expect(await runtime.start(piece)).toBe(true);
    const cancel = piece.sink(() => {});
    await catchingUp.promise;
    await movePointer(v2Ref);
    await setupStaged.promise;
    caughtUp.resolve();
    await catchUpEnded.promise;
    await runtime.idle();
    setupSettles.resolve();
    await runtime.runner.patternPointerFollowed(piece);
    await settled();
    runtime.prepareTxForCommit = prepare;

    expect(refusals).toBe(1);
    expect(actionIds[0]).toBe(
      repairOwed ? "piece-start-repair" : "piece-instantiate",
    );
    return { piece, input, failures, cancel };
  };

  /** Sets the piece's input to `value`, and returns the piece once settled. */
  const recomputeWith = async (
    piece: Awaited<ReturnType<typeof recoverAcrossPointerMove>>,
    value: number,
  ) => {
    expect(
      (await runtime.editWithRetry((tx) => piece.input.withTx(tx).set(value)))
        .error,
    ).toBeUndefined();
    await settled();
    return piece.piece.get();
  };

  describe("a pointer move during the catch-up", () => {
    // A refused instantiation retires its graph and waits for a catch-up
    // before it instantiates again. A pointer that moves during that wait has
    // a swap of its own on the way, which either lands and runs the incoming
    // pattern, or keeps the running pattern.

    it("instantiates the running pattern again when the incoming pattern's setup is refused", async () => {
      const recovered = await recoverAcrossPointerMove({
        repairOwed: false,
        swapLands: false,
      });

      expect(runtime.runner.pieceGraphIsInstalled(recovered.piece)).toBe(true);
      expect(recovered.failures).toEqual([]);
      expect(await recomputeWith(recovered, 4)).toEqual({ slots: [8] });
      recovered.cancel();
    });

    it("runs the incoming pattern when its setup lands, for a start owed a setup repair", async () => {
      const recovered = await recoverAcrossPointerMove({
        repairOwed: true,
        swapLands: true,
      });

      expect(runtime.runner.pieceGraphIsInstalled(recovered.piece)).toBe(true);
      expect(recovered.failures).toEqual([]);
      expect(await recomputeWith(recovered, 4)).toEqual({ slots: [12] });
      recovered.cancel();
    });

    it("reports the start as failed when the incoming pattern's setup is refused, for a start owed a setup repair", async () => {
      const recovered = await recoverAcrossPointerMove({
        repairOwed: true,
        swapLands: false,
      });

      expect(recovered.failures.map((error) => (error as Error).message))
        .toEqual([
          expect.stringContaining(
            "moved to another pattern while its setup was being repaired",
          ),
        ]);
      expect(runtime.runner.isRunning(recovered.piece)).toBe(false);
      recovered.cancel();
    });
  });
});
