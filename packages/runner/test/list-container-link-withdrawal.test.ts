/**
 * A list coordinator's first reconcile writes the link from the node's output
 * binding to the result container it mints, and records that link as issued.
 * On a serving runtime that reconcile's transaction commits when it is sealed
 * into a wave, and the wave can still withdraw it afterwards: a contribution
 * that read a pending write the wave drops is dropped with it, and the
 * scheduler re-arms the reconcile once the replica has rolled it back.
 *
 * The re-armed reconcile issues the link again only if the coordinator knows
 * the first issuance never became durable. If it does not, the container fills
 * while nothing points at it, and the output reads `undefined` for as long as
 * the coordinator lives.
 *
 * The first scenario, with nothing timed:
 *
 *   1. An empty source list is seeded, a wave opens on the store as it stands,
 *      and an authored write then changes the source document behind the
 *      wave's back.
 *   2. A derivation rewrites the list inside the wave. Its basis is now stale,
 *      so the wave drops it when it commits.
 *   3. A pattern over the list starts. Its coordinator's first reconcile reads
 *      the list through that pending write, so the wave drops it too.
 *   4. The wave commits, the scheduler re-arms the coordinator, and its re-run
 *      is sealed into the next wave, which commits.
 *   5. Another client fills the list, and the coordinator's reconcile of that
 *      change is sealed into a third wave, which commits.
 *
 * An element's setup writes are on the same ledger, and the second scenario
 * loses them instead: another client adds an element, the wave carrying the
 * reconcile that set it up is abandoned, and the next change to the list is
 * reconciled in a wave that commits. Unless the ledger owes the element its
 * setup again, that reconcile reuses it as it stands and it reads as missing.
 *
 * `map`, `filter` and `flatMap` share the ledger, so each gets both runs.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { isRawBuiltinResult, raw } from "../src/module.ts";
import { map } from "../src/builtins/map.ts";
import { filter } from "../src/builtins/filter.ts";
import { flatMap } from "../src/builtins/flatmap.ts";
import { stampWaveRunContext, waveSettlementOf } from "../src/executor/wave.ts";
import { ServingWaves } from "./support/serving-waves.ts";

const signer = await Identity.fromPassphrase("list container link withdrawal");
const space = signer.did() as MemorySpace;

// The three list builtins, each with a program whose aggregate the coordinator
// owns and the value that aggregate holds once it has converged over [1, 2, 3].
const COORDINATORS = [
  {
    name: "map",
    // deno-lint-ignore no-explicit-any
    implementation: map as any,
    body: "items.map((n) => n * 2)",
    expected: [2, 4, 6],
  },
  {
    name: "filter",
    // deno-lint-ignore no-explicit-any
    implementation: filter as any,
    body: "items.filter((n) => n > 1)",
    expected: [2, 3],
  },
  {
    name: "flatMap",
    // deno-lint-ignore no-explicit-any
    implementation: flatMap as any,
    body: "items.flatMap((n) => [n, n])",
    expected: [1, 1, 2, 2, 3, 3],
  },
] as const;

const programFor = (body: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: number[] }>(({ items }) => {",
      `  return { aggregate: ${body} };`,
      "});",
    ].join("\n"),
  }],
});

/** What the coordinator under test did, as the test observed it. */
type CoordinatorRecord = {
  /** The containers it linked its output binding to, in order. */
  linked: Cell<unknown[]>[];

  /** Whether the wave withdrew its first reconcile's contribution. */
  firstWithdrawn?: Promise<boolean>;
};

/**
 * Re-register a list builtin so the test can see which containers the
 * coordinator linked its output binding to, and whether the wave withdrew its
 * first reconcile. The coordinator, its bookkeeping and its writes are the real
 * ones; only the reporting is added.
 */
function observeCoordinator(
  runtime: Runtime,
  ref: string,
  // deno-lint-ignore no-explicit-any
  implementation: any,
): CoordinatorRecord {
  const record: CoordinatorRecord = { linked: [] };
  runtime.moduleRegistry.addModuleByRef(
    ref,
    raw((
      inputsCell,
      sendResult,
      addCancel,
      cause,
      parentCell,
      rt,
      outputBinding,
      awaitSync,
      // deno-lint-ignore no-explicit-any
    ): any => {
      const built = implementation(
        inputsCell,
        // deno-lint-ignore no-explicit-any
        (tx: IExtendedStorageTransaction, value: any) => {
          record.linked.push(value as Cell<unknown[]>);
          sendResult(tx, value);
        },
        addCancel,
        cause,
        parentCell,
        rt,
        outputBinding,
        awaitSync,
      );
      const action = isRawBuiltinResult(built) ? built.action : built;
      const observed = (tx: IExtendedStorageTransaction) => {
        action(tx);
        if (record.firstWithdrawn !== undefined) return;
        const withdrawn = Promise.withResolvers<boolean>();
        record.firstWithdrawn = withdrawn.promise;
        tx.addCommitCallback((committed, result) => {
          const settlement = waveSettlementOf(committed) ??
            waveSettlementOf(tx);
          if (result.error || settlement === undefined) {
            withdrawn.resolve(false);
          } else {
            settlement.then((outcome) =>
              withdrawn.resolve(outcome.error !== undefined)
            );
          }
        });
      };
      return isRawBuiltinResult(built)
        ? { ...built, action: observed }
        : observed;
      // deno-lint-ignore no-explicit-any
    }) as any,
  );
  return record;
}

describe("list container link withdrawal", () => {
  let waves: ServingWaves;
  let runtime: Runtime;

  beforeEach(async () => {
    waves = await ServingWaves.open(signer);
    runtime = waves.runtime;
  });

  afterEach(async () => {
    await waves.dispose();
  });

  const newSource = async (name: string, list: number[]) => {
    const source = runtime.getCell<{ list: number[]; tag?: string }>(
      space,
      `${name} source`,
      undefined,
    );
    const seed = runtime.edit();
    source.withTx(seed).set({ list });
    expect((await seed.commit()).error).toBeUndefined();
    await waves.storageManager.synced();
    return source;
  };

  // Another client replaces the list, and the serving runtime reconciles what
  // it sees.
  const replaceList = (
    source: Cell<{ list: number[]; tag?: string }>,
    list: number[],
  ) => waves.writeAsPeer(source, (cell) => cell.key("list").set(list));

  // Starts the program over the source's list, and reads its aggregate as a
  // viewer would, so the coordinator runs.
  const start = async (
    name: string,
    body: string,
    source: Cell<{ list: number[]; tag?: string }>,
  ) => {
    const compiled = await runtime.patternManager.compilePattern(
      programFor(body),
      { space },
    );
    await runtime.patternManager.flushCompileCacheWrites();
    const setup = runtime.edit();
    stampWaveRunContext(setup, {
      actionId: `setup/${name}`,
      kind: "bookkeeping",
    });
    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      `${name} result`,
      compiled.resultSchema,
      setup,
    );
    runtime.run(setup, compiled, { items: source.key("list") }, resultCell);
    expect((await setup.commit()).error).toBeUndefined();
    const stopReading = resultCell.key("aggregate").sink(() => {});
    await runtime.scheduler.idleWithPendingCommits();
    return { resultCell, stopReading };
  };

  for (const coordinator of COORDINATORS) {
    describe(coordinator.name, () => {
      it("links its output to its aggregate after a wave withdraws its first reconcile", async () => {
        const record = observeCoordinator(
          runtime,
          coordinator.name,
          coordinator.implementation,
        );
        const source = await newSource(coordinator.name, []);

        // The wave opens before an authored write moves the source on, so the
        // rewrite sealed into it below reads a stale basis.
        waves.openWave();
        const authored = runtime.edit();
        source.withTx(authored).key("tag").set("authored");
        expect((await authored.commit()).error).toBeUndefined();
        waves.serve();
        const doomed = runtime.edit();
        stampWaveRunContext(doomed, {
          actionId: "rewrite-source",
          kind: "derivation",
        });
        source.withTx(doomed).key("list").set([0]);
        expect((await doomed.commit()).error).toBeUndefined();

        const { resultCell, stopReading } = await start(
          coordinator.name,
          coordinator.body,
          source,
        );
        try {
          await waves.commitWave();
          expect(
            await record.firstWithdrawn,
            "the wave withdrew the coordinator's first reconcile",
          ).toBe(true);
          expect(
            waves.current,
            "the re-armed reconcile was sealed into the next wave",
          ).toBeDefined();
          await waves.commitWave();
          expect(waves.current, "nothing further was sealed").toBeUndefined();

          await replaceList(source, [1, 2, 3]);
          expect(
            waves.current,
            "the reconcile of the filled list was sealed into a wave",
          ).toBeDefined();
          await waves.commitWave();
          await waves.storageManager.synced();

          const container = record.linked.at(-1);
          expect(container, "the coordinator linked a container")
            .toBeDefined();
          expect(
            await runtime.getCellFromLink<unknown[]>(
              container!.getAsNormalizedFullLink(),
            ).pull(),
            "the coordinator filled the container",
          ).toEqual(coordinator.expected);
          expect(
            await resultCell.key("aggregate").pull(),
            "the output reaches the aggregate through the container's link",
          ).toEqual(coordinator.expected);
        } finally {
          stopReading();
        }
      });

      it("sets up an element again after the wave that added it is abandoned", async () => {
        const source = await newSource(coordinator.name, [1]);
        waves.serve();
        const { resultCell, stopReading } = await start(
          coordinator.name,
          coordinator.body,
          source,
        );
        try {
          await waves.commitWave();

          await replaceList(source, [1, 2]);
          expect(
            waves.current,
            "the reconcile that added an element was sealed into a wave",
          ).toBeDefined();
          await waves.abandonWave();

          await replaceList(source, [1, 2, 3]);
          expect(
            waves.current,
            "the next reconcile was sealed into a wave",
          ).toBeDefined();
          await waves.commitWave();
          await waves.storageManager.synced();

          expect(
            await resultCell.key("aggregate").pull(),
            "every element of the aggregate is set up",
          ).toEqual(coordinator.expected);
        } finally {
          stopReading();
        }
      });
    });
  }
});
