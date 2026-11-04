import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTransactionCommitReceipt } from "../src/storage/commit-receipt.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { getMetaLink } from "../src/link-utils.ts";
import type { Cell } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("list element issuance ownership");
const space = signer.did();

// Two runs of one map coordinator overlap. The first creates a new element and
// writes that element's links back to the coordinator; before it commits, a
// second run moves the same element to a new index, re-runs its pattern without
// re-writing its links, and takes over the element's setup record. The first
// run is then rejected on a stale basis.
//
// The pair differs in one step: whether the overlapping run happens. The
// control lets the rejected run's retry converge on its own.

type Outcome = {
  rejection: string | undefined;
  aggregate: unknown;

  /** Ids of element documents left without a `result` meta. */
  missing: string[];

  /** The element the held reconcile created. */
  createdId: string | undefined;
};

describe("list element issuance ownership", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  async function run(
    label: string,
    { overlap, listOp }: { overlap: boolean; listOp: string },
  ): Promise<Outcome> {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const tagIndex = lift(
      (input: { element: number; index: number }) =>
        listOp === "filterWithPattern"
          ? (input.element + input.index) % 2 === 0
          : input.element * 100 + input.index,
    );
    // No explicit argument schema: legacy mode reports every argument as used,
    // so usesIndex is true and a reused element that moves re-runs its op.
    // deno-lint-ignore no-explicit-any
    const op = pattern(({ element, index }: any) =>
      tagIndex({ element, index })
    );

    const setupTx = runtime.edit();
    const cellA = runtime.getCell<number>(
      space,
      `${label}-a`,
      undefined,
      setupTx,
    );
    cellA.withTx(setupTx).set(1);
    const cellB = runtime.getCell<number>(
      space,
      `${label}-b`,
      undefined,
      setupTx,
    );
    cellB.withTx(setupTx).set(2);
    const cellC = runtime.getCell<number>(
      space,
      `${label}-c`,
      undefined,
      setupTx,
    );
    cellC.withTx(setupTx).set(3);

    const mapPattern = pattern<{ values: number[] }>(({ values }) => ({
      values,
      tagged: (values as unknown as Record<string, any>)[listOp](
        // deno-lint-ignore no-explicit-any
        op as any,
        {},
      ),
    }));
    const resultCell = runtime.getCell<
      { values: number[]; tagged: number[] }
    >(space, label, undefined, setupTx);
    const result = runtime.run(setupTx, mapPattern, {
      values: [cellA, cellB],
    }, resultCell);
    expect((await setupTx.commit().settled).error).toBeUndefined();

    const stopReading = result.key("tagged").sink(() => {});
    const originalRun = runtime.runner.run;
    const elementCells: Cell<any>[] = [];
    let armed = false;
    let createdIndex = -1;
    const heldReconcile = Promise.withResolvers<void>();
    const captured = Promise.withResolvers<void>();
    let sourceAction: unknown;
    let rejection: { name?: string } | undefined;

    runtime.runner.run = ((...args: Parameters<typeof originalRun>) => {
      const ran = Reflect.apply(originalRun, runtime.runner, args);
      const options = args[4] as
        | { doNotUpdateOnPatternChange?: boolean }
        | undefined;
      if (options?.doNotUpdateOnPatternChange !== true) return ran;
      elementCells.push(args[3] as Cell<any>);
      if (!armed) return ran;
      armed = false;
      // The first per-element run of the held reconcile is the newly created
      // element at index 0.
      createdIndex = elementCells.length - 1;
      const reconcileTx = args[0] as IExtendedStorageTransaction;
      sourceAction =
        (reconcileTx as unknown as { tx: { sourceAction?: unknown } }).tx
          .sourceAction;
      reconcileTx.addCommitCallback((_settled, res) => {
        rejection = res.error;
      });
      const originalCommit = reconcileTx.commit.bind(reconcileTx);
      reconcileTx.commit = (() =>
        createTransactionCommitReceipt(
          heldReconcile.promise.then(() => originalCommit().settled),
        )) as typeof reconcileTx.commit;
      captured.resolve();
      return ran;
    }) as typeof runtime.runner.run;

    try {
      await runtime.scheduler.idleWithPendingCommits();

      armed = true;
      const addTx = runtime.edit();
      result.withTx(addTx).key("values").set([cellC, cellA, cellB]);
      expect((await addTx.commit().settled).error).toBeUndefined();
      await captured.promise;
      expect(sourceAction).toBeDefined();

      if (overlap) {
        // A second reconcile for the same coordinator while the first is still
        // awaiting its commit: C already exists in the coordinator's memory and
        // its index moves, so this reconcile re-runs C's pattern without
        // re-writing C's links, and takes over C's setup record.
        const moveTx = runtime.edit();
        result.withTx(moveTx).key("values").set([cellA, cellC, cellB]);
        expect((await moveTx.commit().settled).error).toBeUndefined();
        // deno-lint-ignore no-explicit-any
        await runtime.scheduler.run(sourceAction as any);
      }

      heldReconcile.resolve();
      await runtime.scheduler.idleWithPendingCommits();

      const aggregate = await result.key("tagged").pull();
      const probeTx = runtime.edit();
      try {
        const seen = new Set<string>();
        const missing: string[] = [];
        for (const cell of elementCells) {
          const id = cell.getAsNormalizedFullLink().id;
          if (seen.has(id)) continue;
          seen.add(id);
          if (getMetaLink(cell.withTx(probeTx), "result") === undefined) {
            missing.push(id);
          }
        }
        return {
          rejection: rejection?.name,
          aggregate,
          missing,
          createdId: createdIndex < 0
            ? undefined
            : elementCells[createdIndex].getAsNormalizedFullLink().id,
        };
      } finally {
        probeTx.abort("element link probe");
      }
    } finally {
      runtime.runner.run = originalRun;
      heldReconcile.resolve();
      stopReading();
    }
  }

  for (
    const [name, listOp] of [
      ["map", "mapWithPattern"],
      ["filter", "filterWithPattern"],
    ] as const
  ) {
    it(`re-links a created ${name} element when its rejected reconcile retries alone`, async () => {
      const outcome = await run(`probe-control-${name}`, {
        overlap: false,
        listOp,
      });

      expect(outcome.rejection, "the held reconcile lost its commit").toBe(
        "StorageTransactionInconsistent",
      );
      expect(
        outcome.missing,
        "every element names the piece that owns it",
      ).toEqual([]);
    });

    it(`re-links a created ${name} element when an overlapping reconcile moves it`, async () => {
      const outcome = await run(`probe-overlap-${name}`, {
        overlap: true,
        listOp,
      });

      expect(outcome.rejection, "the held reconcile lost its commit").toBe(
        "StorageTransactionInconsistent",
      );
      expect(
        outcome.missing,
        "every element names the piece that owns it",
      ).toEqual([]);
      expect(outcome.createdId).toBeDefined();
    });
  }
});
