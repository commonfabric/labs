import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { Cell } from "../src/cell.ts";
import { getMetaLink } from "../src/link-utils.ts";
import { Runtime as RuntimeClass } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTransactionCommitReceipt } from "../src/storage/commit-receipt.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import type { Runtime } from "../src/runtime.ts";
import {
  type ElementRun,
  type SetupRecord,
  trackListSetupRollback,
} from "../src/builtins/list-element-rollback.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
  Result,
  Unit,
} from "../src/storage/interface.ts";

// A reconcile's element bookkeeping is plain memory that has to follow the fate
// of the transaction carrying the matching setup writes. These drive the
// rollback directly, so each settle outcome and each ownership case is reached
// on its own rather than through whichever one a coordinator happens to hit.

type SettleableTx = IExtendedStorageTransaction & {
  settle(result: Result<Unit, CommitError>): void;
  callbackCount(): number;
};

function createSettleableTx(): SettleableTx {
  const callbacks: Array<
    (tx: IExtendedStorageTransaction, result: Result<Unit, CommitError>) => void
  > = [];
  const tx = {
    addCommitCallback(
      callback: (
        tx: IExtendedStorageTransaction,
        result: Result<Unit, CommitError>,
      ) => void,
    ): void {
      callbacks.push(callback);
    },
    settle(result: Result<Unit, CommitError>): void {
      for (const callback of callbacks) callback(tx as SettleableTx, result);
    },
    callbackCount: () => callbacks.length,
  };
  return tx as unknown as SettleableTx;
}

function createStoppingRuntime(): {
  runtime: Runtime;
  stopped: Cell<any>[];
  failOn(cell: Cell<any>, error: Error): void;
} {
  const stopped: Cell<any>[] = [];
  const failures = new Map<Cell<any>, Error>();
  const runtime = {
    runner: {
      stop(cell: Cell<any>) {
        stopped.push(cell);
        const failure = failures.get(cell);
        if (failure) throw failure;
      },
    },
  };
  return {
    runtime: runtime as unknown as Runtime,
    stopped,
    failOn: (cell, error) => failures.set(cell, error),
  };
}

function elementCell(name: string): Cell<any> {
  return { toString: () => name } as unknown as Cell<any>;
}

const aborted: Result<Unit, CommitError> = {
  error: {
    name: "StorageTransactionAborted",
    message: "aborted",
    reason: new Error("aborted"),
  },
};
const conflict: Result<Unit, CommitError> = {
  error: { name: "ConflictError", message: "conflict" } as CommitError,
};
const inconsistent: Result<Unit, CommitError> = {
  error: {
    name: "StorageTransactionInconsistent",
    message: "stale basis",
  } as CommitError,
};
const committed: Result<Unit, CommitError> = { ok: {} };

describe("list element rollback", () => {
  it("registers nothing until a reconcile installs something", () => {
    const tx = createSettleableTx();
    const elementRuns = new Map<string, ElementRun>();
    trackListSetupRollback(tx, createStoppingRuntime().runtime, elementRuns);

    expect(tx.callbackCount()).toBe(0);
  });

  it("drops a created entry and stops its piece when the setup aborts", () => {
    const tx = createSettleableTx();
    const { runtime, stopped } = createStoppingRuntime();
    const elementRuns = new Map<string, ElementRun>();
    const rollback = trackListSetupRollback(tx, runtime, elementRuns);

    const entry: ElementRun = {
      resultCell: elementCell("a"),
      lastIndex: 0,
      needsSetup: false,
    };
    elementRuns.set("a", entry);
    rollback.created("a", entry);

    tx.settle(aborted);

    expect(elementRuns.has("a")).toBe(false);
    expect(stopped).toEqual([entry.resultCell]);
  });

  it("keeps everything when the setup commits", () => {
    const tx = createSettleableTx();
    const { runtime, stopped } = createStoppingRuntime();
    const elementRuns = new Map<string, ElementRun>();
    const rollback = trackListSetupRollback(tx, runtime, elementRuns);

    const entry: ElementRun = {
      resultCell: elementCell("a"),
      lastIndex: 0,
      needsSetup: false,
    };
    elementRuns.set("a", entry);
    rollback.created("a", entry);

    tx.settle(committed);

    expect(elementRuns.get("a")).toBe(entry);
    expect(stopped).toEqual([]);
  });

  for (
    const [label, outcome] of [
      ["a conflict", conflict],
      ["a local inconsistency", inconsistent],
    ] as const
  ) {
    it(`keeps everything through ${label}, which re-runs instead`, () => {
      const tx = createSettleableTx();
      const { runtime, stopped } = createStoppingRuntime();
      const elementRuns = new Map<string, ElementRun>();
      const rollback = trackListSetupRollback(tx, runtime, elementRuns);

      const entry: ElementRun = {
        resultCell: elementCell("a"),
        lastIndex: 2,
        needsSetup: false,
      };
      elementRuns.set("a", entry);
      rollback.created("a", entry);
      entry.lastIndex = 5;
      rollback.indexChanged(entry, 2);
      let restored = false;
      rollback.resultReplaced(() => {
        restored = true;
      });

      tx.settle(outcome);

      // The re-run reuses this bookkeeping; discarding it would make each
      // attempt rebuild what the last one threw away. The setup writes are the
      // exception: they went with the transaction, so the re-run issues them.
      expect(elementRuns.get("a")).toBe(entry);
      expect(entry.lastIndex).toBe(5);
      expect(entry.needsSetup).toBe(true);
      expect(stopped).toEqual([]);
      expect(restored).toBe(false);
    });
  }

  it("marks a surviving entry as needing setup again when the setup fails", () => {
    const tx = createSettleableTx();
    const elementRuns = new Map<string, ElementRun>();
    const rollback = trackListSetupRollback(
      tx,
      createStoppingRuntime().runtime,
      elementRuns,
    );

    const entry: ElementRun = {
      resultCell: elementCell("a"),
      lastIndex: 0,
      needsSetup: true,
    };
    elementRuns.set("a", entry);
    rollback.setupIssued(entry);
    expect(entry.needsSetup).toBe(false);

    tx.settle(aborted);

    expect(entry.needsSetup).toBe(true);
  });

  it("leaves a committed entry set up", () => {
    const tx = createSettleableTx();
    const elementRuns = new Map<string, ElementRun>();
    const rollback = trackListSetupRollback(
      tx,
      createStoppingRuntime().runtime,
      elementRuns,
    );

    const entry: ElementRun = {
      resultCell: elementCell("a"),
      lastIndex: 0,
      needsSetup: true,
    };
    elementRuns.set("a", entry);
    rollback.setupIssued(entry);

    tx.settle(committed);

    expect(entry.needsSetup).toBe(false);
  });

  it("leaves an element set up when a later reconcile issued it durably", () => {
    const older = createSettleableTx();
    const newer = createSettleableTx();
    const elementRuns = new Map<string, ElementRun>();
    const { runtime } = createStoppingRuntime();
    const olderRollback = trackListSetupRollback(older, runtime, elementRuns);
    const newerRollback = trackListSetupRollback(newer, runtime, elementRuns);

    const entry: ElementRun = {
      resultCell: elementCell("a"),
      lastIndex: 0,
      needsSetup: true,
    };
    elementRuns.set("a", entry);

    // Two reconciles overlap: the older one is still awaiting its commit when
    // the newer one issues setup for the same element and lands.
    olderRollback.setupIssued(entry);
    newerRollback.setupIssued(entry);
    newer.settle(committed);
    older.settle(aborted);

    // The newer setup is durable, so nothing is owed. Owing it anyway costs
    // the next reconcile a re-issue against documents that are already right.
    expect(entry.needsSetup).toBe(false);
  });

  it("owes an element its setup when the reconcile that issued it last fails", () => {
    const older = createSettleableTx();
    const newer = createSettleableTx();
    const elementRuns = new Map<string, ElementRun>();
    const { runtime } = createStoppingRuntime();
    const olderRollback = trackListSetupRollback(older, runtime, elementRuns);
    const newerRollback = trackListSetupRollback(newer, runtime, elementRuns);

    const entry: ElementRun = {
      resultCell: elementCell("a"),
      lastIndex: 0,
      needsSetup: true,
    };
    elementRuns.set("a", entry);

    olderRollback.setupIssued(entry);
    newerRollback.setupIssued(entry);
    older.settle(committed);
    newer.settle(aborted);

    // The durable setup is the older one, which the newer reconcile's writes
    // were meant to replace, so the element still owes its setup.
    expect(entry.needsSetup).toBe(true);
  });

  it("leaves an entry a later reconcile replaced", () => {
    const tx = createSettleableTx();
    const { runtime, stopped } = createStoppingRuntime();
    const elementRuns = new Map<string, ElementRun>();
    const rollback = trackListSetupRollback(tx, runtime, elementRuns);

    const entry: ElementRun = {
      resultCell: elementCell("a"),
      lastIndex: 0,
      needsSetup: false,
    };
    elementRuns.set("a", entry);
    rollback.created("a", entry);

    const replacement: ElementRun = {
      resultCell: elementCell("a-replacement"),
      lastIndex: 0,
      needsSetup: false,
    };
    elementRuns.set("a", replacement);

    tx.settle(aborted);

    expect(elementRuns.get("a")).toBe(replacement);
    expect(stopped).toEqual([]);
  });

  it("restores an index it moved", () => {
    const tx = createSettleableTx();
    const elementRuns = new Map<string, ElementRun>();
    const rollback = trackListSetupRollback(
      tx,
      createStoppingRuntime().runtime,
      elementRuns,
    );

    const entry: ElementRun = {
      resultCell: elementCell("a"),
      lastIndex: 1,
      needsSetup: false,
    };
    elementRuns.set("a", entry);
    entry.lastIndex = 4;
    rollback.indexChanged(entry, 1);

    tx.settle(aborted);

    expect(entry.lastIndex).toBe(1);
  });

  it("keeps the first index it moved away from across two moves", () => {
    const tx = createSettleableTx();
    const elementRuns = new Map<string, ElementRun>();
    const rollback = trackListSetupRollback(
      tx,
      createStoppingRuntime().runtime,
      elementRuns,
    );

    const entry: ElementRun = {
      resultCell: elementCell("a"),
      lastIndex: 1,
      needsSetup: false,
    };
    elementRuns.set("a", entry);
    entry.lastIndex = 4;
    rollback.indexChanged(entry, 1);
    entry.lastIndex = 7;
    rollback.indexChanged(entry, 4);

    tx.settle(aborted);

    expect(entry.lastIndex).toBe(1);
  });

  it("leaves an index a later reconcile moved again", () => {
    const tx = createSettleableTx();
    const elementRuns = new Map<string, ElementRun>();
    const rollback = trackListSetupRollback(
      tx,
      createStoppingRuntime().runtime,
      elementRuns,
    );

    const entry: ElementRun = {
      resultCell: elementCell("a"),
      lastIndex: 1,
      needsSetup: false,
    };
    elementRuns.set("a", entry);
    entry.lastIndex = 4;
    rollback.indexChanged(entry, 1);
    // A later reconcile owns the entry now, and its index matches writes of
    // its own.
    entry.lastIndex = 9;

    tx.settle(aborted);

    expect(entry.lastIndex).toBe(9);
  });

  for (
    const [label, outcome] of [
      ["a conflict", conflict],
      ["a local inconsistency", inconsistent],
      ["an abort", aborted],
    ] as const
  ) {
    it(`owes the result container its links through ${label}`, () => {
      const tx = createSettleableTx();
      const rollback = trackListSetupRollback(
        tx,
        createStoppingRuntime().runtime,
        new Map<string, ElementRun>(),
      );

      const container: SetupRecord = { needsSetup: true };
      rollback.setupIssued(container);
      expect(container.needsSetup).toBe(false);

      tx.settle(outcome);

      // The container survives a stale basis while its links do not, so the
      // re-run has to issue them again against the container it still holds.
      expect(container.needsSetup).toBe(true);
    });
  }

  it("leaves the result container linked when its reconcile commits", () => {
    const tx = createSettleableTx();
    const rollback = trackListSetupRollback(
      tx,
      createStoppingRuntime().runtime,
      new Map<string, ElementRun>(),
    );

    const container: SetupRecord = { needsSetup: true };
    rollback.setupIssued(container);

    tx.settle(committed);

    expect(container.needsSetup).toBe(false);
  });

  it("leaves a result container a later reconcile replaced", () => {
    const older = createSettleableTx();
    const newer = createSettleableTx();
    const elementRuns = new Map<string, ElementRun>();
    const { runtime } = createStoppingRuntime();
    const olderRollback = trackListSetupRollback(older, runtime, elementRuns);
    const newerRollback = trackListSetupRollback(newer, runtime, elementRuns);

    // The shape of the container install in map/filter/flatMap: each reconcile
    // captures the container it replaced and the one it installed, and gives
    // back only what it installed.
    let container = "first";
    const previousForOlder = container;
    container = "older";
    const installedByOlder = container;
    olderRollback.resultReplaced(() => {
      if (container === installedByOlder) container = previousForOlder;
    });

    const previousForNewer = container;
    container = "newer";
    const installedByNewer = container;
    newerRollback.resultReplaced(() => {
      if (container === installedByNewer) container = previousForNewer;
    });

    newer.settle(committed);
    older.settle(aborted);

    expect(container).toBe("newer");
  });

  it("restores a result container it installed", () => {
    const tx = createSettleableTx();
    const rollback = trackListSetupRollback(
      tx,
      createStoppingRuntime().runtime,
      new Map<string, ElementRun>(),
    );

    let container: string | undefined = "installed";
    const previous = undefined;
    rollback.resultReplaced(() => {
      container = previous;
    });

    tx.settle(aborted);

    expect(container).toBeUndefined();
  });

  it("does not restore an index belonging to an entry it dropped", () => {
    const tx = createSettleableTx();
    const { runtime } = createStoppingRuntime();
    const elementRuns = new Map<string, ElementRun>();
    const rollback = trackListSetupRollback(tx, runtime, elementRuns);

    const entry: ElementRun = {
      resultCell: elementCell("a"),
      lastIndex: 3,
      needsSetup: false,
    };
    elementRuns.set("a", entry);
    rollback.created("a", entry);
    entry.lastIndex = 6;
    rollback.indexChanged(entry, 3);

    tx.settle(aborted);

    // The entry is gone, so its index is not restored to a slot it no longer
    // occupies.
    expect(elementRuns.has("a")).toBe(false);
    expect(entry.lastIndex).toBe(6);
  });

  it("surfaces a single failing stop", () => {
    const tx = createSettleableTx();
    const { runtime, failOn } = createStoppingRuntime();
    const elementRuns = new Map<string, ElementRun>();
    const rollback = trackListSetupRollback(tx, runtime, elementRuns);

    const entry: ElementRun = {
      resultCell: elementCell("a"),
      lastIndex: 0,
      needsSetup: false,
    };
    elementRuns.set("a", entry);
    rollback.created("a", entry);
    const failure = new Error("stop failed");
    failOn(entry.resultCell, failure);

    expect(() => tx.settle(aborted)).toThrow(failure);
    expect(elementRuns.has("a")).toBe(false);
  });

  it("surfaces a failing container restore", () => {
    const tx = createSettleableTx();
    const rollback = trackListSetupRollback(
      tx,
      createStoppingRuntime().runtime,
      new Map<string, ElementRun>(),
    );

    const failure = new Error("restore failed");
    rollback.resultReplaced(() => {
      throw failure;
    });

    expect(() => tx.settle(aborted)).toThrow(failure);
  });

  it("runs the remaining rollbacks after a container restore throws", () => {
    const tx = createSettleableTx();
    const { runtime, stopped } = createStoppingRuntime();
    const elementRuns = new Map<string, ElementRun>();
    const rollback = trackListSetupRollback(tx, runtime, elementRuns);

    const entry: ElementRun = {
      resultCell: elementCell("a"),
      lastIndex: 0,
      needsSetup: false,
    };
    elementRuns.set("a", entry);
    rollback.created("a", entry);
    rollback.resultReplaced(() => {
      throw new Error("first restore failed");
    });
    let secondRestored = false;
    rollback.resultReplaced(() => {
      secondRestored = true;
    });

    expect(() => tx.settle(aborted)).toThrow();

    expect(stopped).toEqual([entry.resultCell]);
    expect(secondRestored).toBe(true);
  });

  it("aggregates several failing rollbacks and still runs them all", () => {
    const tx = createSettleableTx();
    const { runtime, failOn, stopped } = createStoppingRuntime();
    const elementRuns = new Map<string, ElementRun>();
    const rollback = trackListSetupRollback(tx, runtime, elementRuns);

    const first: ElementRun = {
      resultCell: elementCell("a"),
      lastIndex: 0,
      needsSetup: false,
    };
    const second: ElementRun = {
      resultCell: elementCell("b"),
      lastIndex: 1,
      needsSetup: false,
    };
    elementRuns.set("a", first);
    elementRuns.set("b", second);
    rollback.created("a", first);
    rollback.created("b", second);
    failOn(first.resultCell, new Error("first stop failed"));
    failOn(second.resultCell, new Error("second stop failed"));

    let thrown: unknown;
    try {
      tx.settle(aborted);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.length).toBe(2);
    expect(stopped.length).toBe(2);
    expect(elementRuns.size).toBe(0);
  });
});

// The coordinators install their result container and create their first
// element in one reconcile. When that reconcile's transaction is discarded,
// both records have to go: the container so the next reconcile re-links it, and
// the element so the next reconcile re-runs a setup whose writes are gone.

const coordinatorSigner = await Identity.fromPassphrase(
  "list element rollback coordinators",
);
const coordinatorSpace = coordinatorSigner.did();

type ListOp =
  | "mapWithPattern"
  | "filterWithPattern"
  | "flatMapWithPattern";

describe("a list coordinator whose first reconcile is discarded", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: RuntimeClass;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: coordinatorSigner });
    runtime = new RuntimeClass({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  // Abort the transaction carrying the first per-element setup, at the moment
  // it is committed, so the reconcile runs to completion and then loses
  // everything it staged.
  function abortFirstElementSetup(): {
    restore(): void;
    aborted(): boolean;
  } {
    const originalRun = runtime.runner.run;
    let didAbort = false;
    let setups = 0;
    runtime.runner.run = ((...args: Parameters<typeof originalRun>) => {
      const run = Reflect.apply(originalRun, runtime.runner, args);
      const options = args[4] as
        | { doNotUpdateOnPatternChange?: boolean }
        | undefined;
      if (options?.doNotUpdateOnPatternChange !== true) return run;
      setups++;
      if (setups === 1) {
        const childTx = args[0];
        if (childTx === undefined) {
          throw new Error("element setup had no transaction");
        }
        const originalCommit = childTx.commit.bind(childTx);
        childTx.commit = (() => {
          expect(childTx.abort("abort the first element setup").error)
            .toBeUndefined();
          didAbort = true;
          return originalCommit();
        }) as typeof childTx.commit;
      }
      return run;
    }) as typeof runtime.runner.run;
    return {
      restore: () => {
        runtime.runner.run = originalRun;
      },
      aborted: () => didAbort,
    };
  }

  // Land a write on a document the first reconcile touched, at the moment that
  // reconcile commits, so its commit is rejected against a basis that moved
  // underneath it. Unlike an abort, this rejection is one the scheduler
  // recovers from by re-running the same reconcile, which is what has to
  // re-issue the writes the rejected transaction carried.
  function unsettleFirstElementSetup(): {
    restore(): void;
    rejection(): { name?: string } | undefined;
    elementCells(): Cell<any>[];
  } {
    const originalRun = runtime.runner.run;
    const elementCells: Cell<any>[] = [];
    let rejection: { name?: string } | undefined;
    let setups = 0;
    runtime.runner.run = ((...args: Parameters<typeof originalRun>) => {
      const run = Reflect.apply(originalRun, runtime.runner, args);
      const options = args[4] as
        | { doNotUpdateOnPatternChange?: boolean }
        | undefined;
      if (options?.doNotUpdateOnPatternChange !== true) return run;
      setups++;
      const elementResult = args[3] as Cell<any>;
      elementCells.push(elementResult);
      if (setups !== 1) return run;
      const reconcileTx = args[0];
      if (reconcileTx === undefined) {
        throw new Error("element setup had no transaction");
      }
      reconcileTx.addCommitCallback((_settledTx, result) => {
        rejection = result.error;
      });
      const originalCommit = reconcileTx.commit.bind(reconcileTx);
      reconcileTx.commit = ((
        ...commitArgs: Parameters<typeof originalCommit>
      ) => {
        const moved = runtime.edit();
        elementResult.withTx(moved).setRaw("moved under the reconcile");
        return createTransactionCommitReceipt(
          moved.commit().settled.then(() =>
            originalCommit(...commitArgs).settled
          ),
        );
      }) as typeof reconcileTx.commit;
      return run;
    }) as typeof runtime.runner.run;
    return {
      restore: () => {
        runtime.runner.run = originalRun;
      },
      rejection: () => rejection,
      elementCells: () => elementCells,
    };
  }

  async function runListPattern(
    listOp: ListOp,
    opBody: (element: any) => any,
    label: string,
  ): Promise<Cell<any>> {
    const { cell, lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const operation = pattern<{ element: number }>(({ element }) =>
      lift(opBody)(element)
    );
    const parentPattern = pattern(() => {
      // Non-empty from the start, so one reconcile installs the container and
      // creates the element together.
      const items = cell<number[]>([3]);
      return {
        items,
        derived: (items as unknown as Record<string, any>)[listOp](
          operation,
          {},
        ),
      };
    });
    const setupTx = runtime.edit();
    const parent = runtime.getCell<{ items: number[]; derived: unknown }>(
      coordinatorSpace,
      label,
      undefined,
      setupTx,
    );
    const result = runtime.run(setupTx, parentPattern, {}, parent);
    expect((await setupTx.commit().settled).error).toBeUndefined();
    return result;
  }

  // `backLinksElements` says the coordinator writes the `result` meta that
  // names an element's owning piece. flatMap links its elements to the pattern
  // alone, so it has no such link to lose.
  for (
    const [name, listOp, opBody, expected, backLinksElements] of [
      ["map", "mapWithPattern", (value: number) => value * 2, [6], true],
      ["filter", "filterWithPattern", (value: number) => value > 1, [3], true],
      ["flatMap", "flatMapWithPattern", (value: number) => [value, value], [
        3,
        3,
      ], false],
    ] as const
  ) {
    it(`rebuilds a ${name} element and its container`, async () => {
      const abort = abortFirstElementSetup();
      try {
        const result = await runListPattern(
          listOp,
          opBody,
          `discarded first reconcile ${name}`,
        );
        const stopReading = result.key("derived").sink(() => {});
        try {
          await runtime.scheduler.idleWithPendingCommits();
          expect(abort.aborted()).toBe(true);
          expect(await result.key("derived").pull()).toEqual([...expected]);
        } finally {
          stopReading();
        }
      } finally {
        abort.restore();
      }
    });

    if (backLinksElements) {
      it(`re-links a ${name} element to its coordinator when the first reconcile is stale`, async () => {
        const unsettle = unsettleFirstElementSetup();
        try {
          const result = await runListPattern(
            listOp,
            opBody,
            `stale first reconcile element links ${name}`,
          );
          const stopReading = result.key("derived").sink(() => {});
          try {
            await runtime.scheduler.idleWithPendingCommits();
            expect(unsettle.rejection()?.name).toBe(
              "StorageTransactionInconsistent",
            );
            // The element's own document names the piece that owns it. A
            // reader that loses this link cannot start that piece for an event
            // addressed to the element.
            const element = unsettle.elementCells()[0];
            const probeTx = runtime.edit();
            try {
              expect(getMetaLink(element.withTx(probeTx), "result"))
                .toBeDefined();
            } finally {
              probeTx.abort("element link probe");
            }
          } finally {
            stopReading();
          }
        } finally {
          unsettle.restore();
        }
      });
    }

    it(`re-links a ${name} container when the first reconcile is stale`, async () => {
      const unsettle = unsettleFirstElementSetup();
      try {
        const result = await runListPattern(
          listOp,
          opBody,
          `stale first reconcile ${name}`,
        );
        const stopReading = result.key("derived").sink(() => {});
        try {
          await runtime.scheduler.idleWithPendingCommits();
          // The premise: the reconcile was rejected on its basis, not on
          // anything else, so the scheduler re-ran it and the re-run is what
          // has to make the container reachable again.
          expect(unsettle.rejection()?.name).toBe(
            "StorageTransactionInconsistent",
          );
          expect(await result.key("derived").pull()).toEqual([...expected]);
        } finally {
          stopReading();
        }
      } finally {
        unsettle.restore();
      }
    });
  }
});
