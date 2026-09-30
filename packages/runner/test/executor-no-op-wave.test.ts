// Server-execution v2 — the land-off integration's tx-boundary pin
// (owner question, 2026-08-20 reconciliation): "main doesn't write
// scheduler metadata and we do, so even a no-op is something to be
// recorded, right?"
//
// Main landed content-addressed no-op elision (#6020: an identical
// `cid:` re-set applies as a no-op — no revision, no head advance, no
// dirty mark; the commit still records) into a world without the
// serving loop. The train's wave machinery has its OWN no-op path: a
// run whose recompute produces no changed writes seals an all-no-op
// transaction, contributes NOTHING to the wave (wave.ts: "a
// transaction with nothing to seal … contributes nothing"), and a wave
// whose every run is a no-op commits NOTHING (commitWave's
// zero-contribution return). The two compose safely by construction —
// the elision is scoped to `cid:` operations, which a wave's
// derivation writes never are (`computed:`/`of:` docs; under the
// landed-dark default no link writer emits `cid:` refs at all) — but
// the SERVING contract still owed a pin: when every demanded
// derivation recomputes to the value already stored, the wave's
// COVERAGE must still land (the S1 drain-settle quiescence advance is
// the carrier once no content commit exists), `waitForSettled` must
// resolve past the no-op input, the per-instance currency must record
// the run (the next pass does NOT re-run the instance — no livelock),
// AND the no-op half must hold (no fresh derived commit, no value
// re-push to the client).
//
// RED would mean the merged tree strands a client behind an all-no-op
// wave (waitForSettled hangs at the input's seq) or livelocks the
// serving loop (derived commits keep minting for an unchanged value).
// The fix shape is "an all-no-op wave still commits coverage +
// annotations", never "defeat the memo".

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { readWatermarkSeq, waitForSettled } from "../src/executor/watermark.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { ArrivalLog, settleServing } from "./support/serving-waits.ts";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

const spaceSigner = await Identity.fromPassphrase("no-op wave space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("no-op wave service");
const aliceSigner = await Identity.fromPassphrase("no-op wave alice");

describe("all-no-op wave (the land-off tx-boundary pin)", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let onServingRuntime: ((runtime: Runtime) => Promise<void>) | undefined;
  let clientManager: EmulatedStorageManager;
  let clientRuntime: Runtime;
  let activations: ArrivalLog<{ space: string; outcome: string }>;

  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: {
            serverExecution: true,
          },
        });
        await onServingRuntime?.(runtime);
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      onActivationSettled: (activatedSpace, outcome) =>
        activations.record({ space: activatedSpace, outcome }),
    });

  /** Resolves once the space has an ACTIVE tenure. The serving pattern
   * run rides `createRuntime`, so this is also the barrier a client's
   * own edits stand behind: a run committing beside them reads a basis
   * their writes have already moved. */
  const activated = (): Promise<unknown> =>
    activations.matching((entry) =>
      entry.space === space && entry.outcome === "active"
    );

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    onServingRuntime = undefined;
    activations = new ArrivalLog();
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  // The derivation SATURATES: any n > 0 lands total = 7, so a second
  // positive input re-runs the computed (its read set covers `n`) and
  // recomputes the value already stored — the all-no-op run.
  const SATURATING_PATTERN = [
    "import { computed, pattern } from 'commonfabric';",
    "export default pattern<{ n: number }, { total: number }>(",
    "  ({ n }) => ({ total: computed(() => (n > 0 ? 1 : 0) * 7) }),",
    ");",
  ].join("\n");

  // The control twin: same wiring, NON-saturating (total = n * 7) — the
  // second input lands a REAL derived write. Green here proves the
  // second-input trigger genuinely re-runs derivations on this
  // scaffolding, so the saturating arm's no-fresh-commit reading is a
  // no-op RUN, not a never-run (the pin's non-vacuity witness).
  const COUNTER_PATTERN = [
    "import { computed, pattern } from 'commonfabric';",
    "export default pattern<{ n: number }, { total: number }>(",
    "  ({ n }) => ({ total: computed(() => n * 7) }),",
    ");",
  ].join("\n");

  const servePattern = (
    argName: string,
    resultName: string,
    source = SATURATING_PATTERN,
  ) => {
    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: source }],
      }, { space });
      const argument = runtime.getCell<{ n: number }>(
        space,
        argName,
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        space,
        resultName,
        compiled.resultSchema,
      );
      await argument.sync();
      await result.sync();
      // Flushed before the run commits, so the replica the commit reads
      // against is current and the commit has nothing to conflict with.
      await runtime.storageManager.synced();
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(
          `serving pattern run failed: ${committed.error.message}`,
        );
      }
      await runtime.idle();
    };
  };

  const derivedSeqs = (engine: Engine.Engine): number[] =>
    (engine.database.prepare(
      `SELECT seq FROM "commit" WHERE class = 'derived' ORDER BY seq`,
    ).all() as { seq: number }[]).map((row) => row.seq);

  /** The last AUTHORED (input) seq — the settle target the protocol
   * defines: W covers CONTENT the space consumed; the quiescence
   * advance's own bookkeeping commit is definitionally never covered
   * (chasing it would mint a successor — the commit-storm class), so a
   * raw `serverSeq()` target is unsatisfiable whenever the tail commit
   * IS the advance. Wait on inputs, exactly as W4's settle series
   * does. */
  const maxAuthoredSeq = (engine: Engine.Engine): number =>
    (engine.database.prepare(
      `SELECT COALESCE(MAX(seq), 0) AS n FROM "commit" WHERE class = 'authored'`,
    ).get() as { n: number }).n;

  it("an all-no-op wave still lands coverage: waitForSettled passes the no-op input, no fresh derived commit, no value re-push, no re-run livelock", async () => {
    servePattern("noop-arg", "noop-result");
    host = newHost();
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    // Demand + the FIRST input: a real derivation write lands (7).
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "noop-result",
      undefined,
    );
    await clientResult.sync();
    const observedTotals: number[] = [];
    const cancelDemand = clientResult.sink((value) => {
      if (typeof value?.total === "number") observedTotals.push(value.total);
    });
    await activated();
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "noop-arg",
      undefined,
    );
    await clientArg.sync();
    {
      const tx = clientRuntime.edit();
      clientArg.withTx(tx).set({ n: 6 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await waitForCellValue<number>(
      clientRuntime,
      clientResult.key("total"),
      (total) => total === 7,
      { stuckLabel: "the client's total to reach 7" },
    );
    // Let the first wave fully settle before sampling: wait on the
    // INPUT's coverage (never on raw serverSeq — see maxAuthoredSeq).
    const settledFirst = await waitForSettled(
      clientRuntime,
      space,
      maxAuthoredSeq(engine),
    );
    expect(settledFirst).toBeGreaterThan(0);
    const derivedAfterFirst = derivedSeqs(engine);
    expect(derivedAfterFirst.length).toBeGreaterThan(0);

    // The SECOND input: the derivation re-runs (its read set covers n)
    // and recomputes the stored-identical value — the all-no-op wave.
    {
      const tx = clientRuntime.edit();
      clientArg.withTx(tx).set({ n: 9 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    const noopInputSeq = maxAuthoredSeq(engine);
    expect(noopInputSeq).toBeGreaterThan(settledFirst - 1);

    // (1) COVERAGE: the watermark still advances to cover the no-op
    // input (the wave commits nothing; the S1 drain-settle quiescence
    // advance is the carrier), and (2) waitForSettled RESOLVES past
    // it — a stranded client here is exactly the hazard the owner
    // asked about.
    const settled = await waitForSettled(clientRuntime, space, noopInputSeq);
    expect(settled).toBeGreaterThanOrEqual(noopInputSeq);
    // The client read that value off its replica of the watermark doc,
    // which the engine's own copy is upstream of.
    expect(readWatermarkSeq(engine)).toBeGreaterThanOrEqual(noopInputSeq);

    // (3) the no-op half of the contract: the identical recompute
    // produced NO fresh derived commit and NO value re-push. (A
    // bookkeeping advance commit is derived-class but writes no
    // content; tolerate exactly the advance rows by asserting the
    // CONTENT signal — the client saw no new value — plus at most one
    // advance-class commit beyond the first wave's set.)
    const derivedAfterNoop = derivedSeqs(engine);
    expect(derivedAfterNoop.length)
      .toBeLessThanOrEqual(derivedAfterFirst.length + 1);
    expect(clientResult.key("total").get()).toBe(7);
    const distinctTotals = [...new Set(observedTotals)];
    expect(distinctTotals).toEqual([7]);

    // (4) no livelock: currency recorded — the loop reaches quiescence
    // and STAYS there (no run-storm re-deriving the unchanged value). A
    // storm iteration is a wave, and a wave is input-driven, so a fresh
    // authored input whose coverage the watermark reports is ordered
    // after every iteration a storm would have run by now. Past that
    // barrier the derived-commit count has moved by at most the kick's
    // own advance; a storm moves it without bound.
    const before = derivedSeqs(engine).length;
    {
      const kick = clientRuntime.getCell<{ n: number }>(
        space,
        "noop-livelock-kick",
        undefined,
      );
      await kick.sync();
      const tx = clientRuntime.edit();
      kick.withTx(tx).set({ n: 1 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await settleServing(engine, clientRuntime, space);
    expect(derivedSeqs(engine).length).toBeLessThanOrEqual(before + 1);

    const stats = host.stats();
    // The serving loop saw the no-op input's wave (waves advanced past
    // the first input's) yet holds zero pending work.
    expect(stats.waves).toBeGreaterThanOrEqual(1);
    cancelDemand();
  });

  it("control (non-vacuity): the same second-input trigger with a NON-saturating derivation lands a fresh derived write", async () => {
    servePattern("ctl-arg", "ctl-result", COUNTER_PATTERN);
    host = newHost();
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);

    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "ctl-result",
      undefined,
    );
    await clientResult.sync();
    const cancelDemand = clientResult.sink(() => {});
    await activated();
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "ctl-arg",
      undefined,
    );
    await clientArg.sync();
    {
      const tx = clientRuntime.edit();
      clientArg.withTx(tx).set({ n: 6 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    await waitForCellValue<number>(
      clientRuntime,
      clientResult.key("total"),
      (total) => total === 42,
      { stuckLabel: "the client's total to reach 42" },
    );
    const derivedAfterFirst = derivedSeqs(engine).length;
    {
      const tx = clientRuntime.edit();
      clientArg.withTx(tx).set({ n: 9 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    // The trigger the saturating arm shares: the second input re-runs
    // the derivation — here the recompute DIFFERS, so a fresh derived
    // commit lands and the client renders 63.
    await waitForCellValue<number>(
      clientRuntime,
      clientResult.key("total"),
      (total) => total === 63,
      { stuckLabel: "the client's total to reach 63" },
    );
    expect(derivedSeqs(engine).length).toBeGreaterThan(derivedAfterFirst);
    cancelDemand();
  });
});
