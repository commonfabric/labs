// Scheduler reactive retry tests.

import { defer } from "@commonfabric/utils/defer";

import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  Runtime,
  space,
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";
import type {
  Action,
  IExtendedStorageTransaction,
  ReactivityLog,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import { MAX_RETRIES_FOR_REACTIVE } from "../src/scheduler/constants.ts";
import { watchReactiveActionCommit } from "../src/scheduler/run.ts";

describe("reactive retries", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  it(
    "should retry reactive actions when commit fails, up to limit",
    async () => {
      // Establish a source cell to create a read dependency
      const source = runtime.getCell<number>(
        space,
        "should retry reactive actions when commit fails, up to limit 1",
        undefined,
        tx,
      );
      source.set(1);
      await tx.commit();
      tx = runtime.edit();

      // Count runs; force commit failure each time. The action reports its
      // own runs: the run that spends the last of the retry budget resolves
      // `budgetExhausted`, and the run that a later input change triggers
      // resolves `retriggered`.
      let attempts = 0;
      const budgetExhausted = defer();
      const retriggered = defer();
      const reactiveAction: Action = (actionTx) => {
        attempts++;
        // Read to establish dependency so later changes re-trigger
        source.withTx(actionTx).get();
        // Force commit to fail so scheduler retries
        actionTx.abort("force-abort-for-reactive-retry");
        if (attempts === MAX_RETRIES_FOR_REACTIVE) budgetExhausted.resolve();
        if (attempts === MAX_RETRIES_FOR_REACTIVE + 1) retriggered.resolve();
      };

      // Subscribe and run immediately
      runtime.scheduler.subscribe(
        reactiveAction,
        { reads: [], shallowReads: [], writes: [] },
        { isEffect: true },
      );

      // The initial run plus its retries spend the whole budget.
      await budgetExhausted.promise;
      // The commit of that run is still in flight, and whether to retry is
      // decided in that commit's continuation. The commit-aware barrier spans
      // both, so a run past the budget is counted before the assertion reads
      // the count.
      await runtime.scheduler.idleWithPendingCommits();

      expect(attempts).toBe(MAX_RETRIES_FOR_REACTIVE);

      // After reaching retry limit, a subsequent input change should re-trigger
      source.withTx(tx).send(2);
      await tx.commit();
      tx = runtime.edit();

      // Wait for the run the change triggers, then span its commit as well.
      // The budget is spent, so nothing is retried after that run.
      await retriggered.promise;
      await runtime.scheduler.idleWithPendingCommits();

      expect(attempts).toBe(MAX_RETRIES_FOR_REACTIVE + 1);
    },
  );

  // Directly exercise the reactive commit-result classification
  // (`watchReactiveActionCommit`): a whole-runtime commit injector would churn
  // every commit and re-trigger the action externally, confounding the retry
  // count, so drive the watcher with a resolved commit result instead.
  const runWatcher = async (
    errorName: string | undefined,
    initialRetries: number,
    options: {
      canRetry?: () => boolean;
      initialOffBudgetRetries?: number;
      awaitRetryReadiness?: (error: unknown) => Promise<void>;
      handleUnavailable?: () => boolean;
      rejectPromise?: boolean;
      restoreInvalidCauses?: () => void;
      shared?: {
        action: Action;
        offBudgetRetries: WeakMap<Action, number>;
      };
      error?: { name: string; message: string };
    } = {},
  ) => {
    const { rejectPromise = false, shared } = options;
    const action = shared?.action ?? ((() => {}) as unknown as Action);
    const retries = new WeakMap<Action, number>();
    if (initialRetries > 0) retries.set(action, initialRetries);
    const offBudgetRetries = shared?.offBudgetRetries ??
      new WeakMap<Action, number>();
    if (options.initialOffBudgetRetries !== undefined) {
      offBudgetRetries.set(action, options.initialOffBudgetRetries);
    }
    let queued = 0;
    let resubscribed = 0;
    let succeeded = 0;
    const abandoned: unknown[] = [];
    const reported: Error[] = [];
    const error = options.error ??
      (errorName === undefined
        ? undefined
        : { name: errorName, message: `injected ${errorName}` });
    const commitPromise =
      (rejectPromise
        ? Promise.reject(error)
        : Promise.resolve({ error })) as unknown as ReturnType<
          IExtendedStorageTransaction["commit"]
        >;
    await watchReactiveActionCommit({
      canRetry: options.canRetry ?? (() => true),
      awaitRetryReadiness: options.awaitRetryReadiness ??
        (() => Promise.resolve()),
      handleUnavailable: options.handleUnavailable,
      action,
      tx: {
        abandonStagedWork: (error: unknown) => abandoned.push(error),
      } as unknown as IExtendedStorageTransaction,
      log: {} as ReactivityLog,
      retries,
      offBudgetRetries,
      pending: new Set<Action>(),
      commitPromise,
      resubscribe: () => {
        resubscribed++;
      },
      markInvalid: () => {},
      queueExecution: () => {
        queued++;
      },
      getActionId: () => "test-action",
      restoreInvalidCauses: options.restoreInvalidCauses ?? (() => {}),
      reportTerminalRejection: (terminalError) => {
        reported.push(terminalError);
      },
      onSuccess: () => {
        succeeded++;
      },
    });
    return {
      queued,
      resubscribed,
      retries,
      offBudgetRetries,
      action,
      reported,
      succeeded,
      abandoned,
    };
  };

  for (const active of [true, false]) {
    for (
      const outcome of [
        undefined,
        "PreconditionFailedError",
        "RowLabelCommitError",
      ]
    ) {
      it(`settles ${outcome ?? "success"} bookkeeping for an ${active ? "active" : "inactive"} registration`, async () => {
        const r = await runWatcher(outcome, 3, {
          canRetry: () => active,
          initialOffBudgetRetries: 5,
        });
        expect(r.retries.has(r.action)).toBe(false);
        expect(r.offBudgetRetries.has(r.action)).toBe(false);
        expect(r.reported.map((error) => error.name)).toEqual(
          outcome === "RowLabelCommitError" ? [outcome] : [],
        );
        expect(r.succeeded).toBe(outcome === undefined && active ? 1 : 0);
        expect(r.abandoned.length).toBe(outcome === undefined ? 0 : 1);
        expect(r.resubscribed).toBe(0);
        expect(r.queued).toBe(0);
      });
    }
  }

  for (
    const outcome of [
      "ConflictError",
      "StorageTransactionInconsistent",
      "TransactionError",
    ]
  ) {
    it(`abandons an inactive registration's ${outcome} without retry work`, async () => {
      let restored = 0;
      let repaired = 0;
      const error = { name: outcome, message: "retired run" };
      const r = await runWatcher(outcome, 3, {
        error,
        canRetry: () => false,
        initialOffBudgetRetries: 5,
        restoreInvalidCauses: () => {
          restored++;
        },
        awaitRetryReadiness: () => {
          repaired++;
          return Promise.resolve();
        },
      });
      expect(r.retries.get(r.action)).toBe(3);
      expect(r.offBudgetRetries.get(r.action)).toBe(5);
      expect(r.abandoned).toEqual([error]);
      expect(r.reported).toEqual([]);
      expect(restored).toBe(0);
      expect(repaired).toBe(0);
      expect(r.resubscribed).toBe(0);
      expect(r.queued).toBe(0);
    });
  }

  it(
    "does not retry a terminal reactive rejection and clears the retry budget",
    async () => {
      // A deterministic commit-rule refusal (RowLabelCommitError) can never
      // converge; re-running recomputes the identical refused write and its
      // speculative rev bumps starve concurrent siblings. It must not re-queue,
      // and — since the sequence has ended — must clear any accumulated count so
      // a later input-triggered run keeps its full budget for a transient
      // failure. (Contrast the abort case above, which retries to the limit.)
      const r = await runWatcher("RowLabelCommitError", 3);
      expect(r.queued).toBe(0);
      expect(r.retries.has(r.action)).toBe(false);
    },
  );

  it(
    "does not retry a permanent reactive rejection and clears the retry budget",
    async () => {
      const r = await runWatcher("PreconditionFailedError", 3);
      expect(r.queued).toBe(0);
      expect(r.retries.has(r.action)).toBe(false);
      // A permanent rejection is a benign lost idempotency race, not a
      // verdict on the action's output — it stays off the error channel.
      expect(r.reported).toEqual([]);
    },
  );

  it(
    "surfaces a terminal rejection with its refusal reasons and piece attribution",
    async () => {
      // A terminal rejection is a verdict on the action's own output, so it
      // reaches the error channel. The commit rejection is a plain object;
      // the surfaced Error keeps its name and structured reasons, and — a
      // commit rejection carrying no pattern frame — takes its piece
      // attribution from the action's observation identity, scope stripped.
      const action = (() => {}) as unknown as Action;
      (action as {
        schedulerObservationIdentity?: {
          pieceId: string;
          pieceRootId?: string;
          ownerSpace?: string;
        };
      }).schedulerObservationIdentity = {
        // A `user:` scope key carries its own colon, so attribution must come
        // from `pieceRootId` rather than from slicing `pieceId`.
        pieceId: "user:did:key:zPrincipal:of:fid1:attributed",
        pieceRootId: "of:fid1:attributed",
        ownerSpace: "did:key:zTest",
      };
      const r = await runWatcher("CfcCommitRefusalError", 3, {
        shared: { action, offBudgetRetries: new WeakMap<Action, number>() },
        error: {
          name: "CfcCommitRefusalError",
          message: "CFC enforcement rejected commit: writer-fit misfit",
          reasons: ["writer-fit misfit"],
        } as { name: string; message: string },
      });
      expect(r.queued).toBe(0);
      expect(r.retries.has(r.action)).toBe(false);
      expect(r.reported.length).toBe(1);
      const surfaced = r.reported[0] as Error & {
        reasons?: readonly string[];
        pieceId?: string;
        space?: string;
      };
      expect(surfaced.name).toBe("CfcCommitRefusalError");
      expect(surfaced.message).toContain("writer-fit misfit");
      expect(surfaced.reasons).toEqual(["writer-fit misfit"]);
      expect(surfaced.pieceId).toBe("of:fid1:attributed");
      expect(surfaced.space).toBe("did:key:zTest");
    },
  );

  it(
    "retries a transient reactive rejection within the bounded budget",
    async () => {
      // A generic transient error keeps the bounded retry path: it re-queues and
      // charges the counter (proving terminal/permanent are the exceptions).
      const r = await runWatcher("TransactionError", 0);
      expect(r.queued).toBe(1);
      expect(r.retries.get(r.action)).toBe(1);
    },
  );

  it("retries when the storage commit promise rejects", async () => {
    const r = await runWatcher("TransactionError", 0, {
      rejectPromise: true,
    });
    expect(r.queued).toBe(1);
    expect(r.resubscribed).toBe(1);
    expect(r.retries.get(r.action)).toBe(1);
  });

  it(
    "retries a rejected stale-basis error without charging the bounded budget",
    async () => {
      const r = await runWatcher("ConflictError", 3, {
        rejectPromise: true,
      });
      expect(r.queued).toBe(1);
      expect(r.resubscribed).toBe(1);
      expect(r.retries.get(r.action)).toBe(3);
      expect(r.offBudgetRetries.get(r.action)).toBe(1);
    },
  );

  it(
    "does not retry a rejected terminal error and clears the retry budget",
    async () => {
      const r = await runWatcher("RowLabelCommitError", 3, {
        rejectPromise: true,
      });
      expect(r.queued).toBe(0);
      expect(r.resubscribed).toBe(0);
      expect(r.retries.has(r.action)).toBe(false);
    },
  );

  it("retries when the storage commit promise rejects without a reason", async () => {
    const r = await runWatcher(undefined, 0, {
      rejectPromise: true,
    });
    expect(r.queued).toBe(1);
    expect(r.resubscribed).toBe(1);
    expect(r.retries.get(r.action)).toBe(1);
  });

  it("requeues a live conflict after recovery rejects", async () => {
    const r = await runWatcher("ConflictError", 0, {
      awaitRetryReadiness: () => Promise.reject(new Error("session replaced")),
    });
    expect(r.queued).toBe(1);
    expect(r.retries.has(r.action)).toBe(false);
  });

  it("handles unavailability during recovery before abandoning a retired run", async () => {
    const recovering = Promise.withResolvers<void>();
    const repaired = Promise.withResolvers<void>();
    let retired = false;
    const availabilityChecks: boolean[] = [];
    const watched = runWatcher("ConflictError", 3, {
      canRetry: () => !retired,
      awaitRetryReadiness: () => {
        recovering.resolve();
        return repaired.promise;
      },
      handleUnavailable: () => {
        availabilityChecks.push(retired);
        return retired;
      },
    });
    try {
      await recovering.promise;
      retired = true;
      repaired.resolve();
      const r = await watched;
      expect(availabilityChecks).toEqual([false, true]);
      expect(r.resubscribed).toBe(1);
      expect(r.queued).toBe(0);
      expect(r.abandoned).toEqual([]);
      expect(r.retries.get(r.action)).toBe(3);
    } finally {
      repaired.resolve();
      await watched;
    }
  });

  it("repairs a conflict even when it carries no catch-up callback", async () => {
    let recovered: unknown;
    const error = { name: "ConflictError", message: "scoped dependency" };
    const r = await runWatcher("ConflictError", 0, {
      error,
      awaitRetryReadiness: (rejection) => {
        recovered = rejection;
        return Promise.resolve();
      },
    });
    expect(recovered).toBe(error);
    expect(r.queued).toBe(1);
  });

  it("requeues local inconsistency without remote conflict repair", async () => {
    let repairs = 0;
    const r = await runWatcher("StorageTransactionInconsistent", 0, {
      awaitRetryReadiness: () => {
        repairs++;
        return Promise.resolve();
      },
    });
    expect(repairs).toBe(0);
    expect(r.queued).toBe(1);
  });

  it("settles when reactive retry handling throws", async () => {
    const retryHandlingError = new Error("retry handling failed");
    const r = await runWatcher("TransactionError", 0, {
      restoreInvalidCauses: () => {
        throw retryHandlingError;
      },
    });
    expect(r.queued).toBe(0);
    expect(r.resubscribed).toBe(0);
    expect(r.retries.get(r.action)).toBe(1);
  });

  it(
    "retries a same-replica-race rejection off the bounded budget",
    async () => {
      // StorageTransactionInconsistent is a stale-basis rejection, like a
      // conflict: re-running against the settled replica resolves it. It re-arms
      // and re-queues WITHOUT charging the counter, so a burst longer than the
      // budget cannot strand the compute as a zombie. Contrast the generic
      // TransactionError above, which does charge the counter.
      const r = await runWatcher("StorageTransactionInconsistent", 0);
      expect(r.queued).toBe(1);
      expect(r.retries.has(r.action)).toBe(false);
      // Off-budget re-queues are counted separately, for the never-converging
      // diagnostic, without charging the bounded budget.
      expect(r.offBudgetRetries.get(r.action)).toBe(1);
    },
  );

  it(
    "accumulates the off-budget re-queue count across stale-basis retries and clears it on convergence",
    async () => {
      // The off-budget retry assumes the subscription eventually delivers the
      // value. Its re-queue count accumulates across attempts (both stale-basis
      // classes), separate from the bounded budget, so a never-closing loop can
      // be surfaced every OFF_BUDGET_RETRY_WARN_INTERVAL re-queues. It clears
      // when the action finally converges.
      const shared = {
        action: (() => {}) as unknown as Action,
        offBudgetRetries: new WeakMap<Action, number>(),
      };
      await runWatcher("StorageTransactionInconsistent", 0, { shared });
      await runWatcher("ConflictError", 0, { shared });
      expect(shared.offBudgetRetries.get(shared.action)).toBe(2);
      // A successful commit ends the streak and clears the count.
      await runWatcher(undefined, 0, { shared });
      expect(shared.offBudgetRetries.has(shared.action)).toBe(false);
    },
  );

  it(
    "should preserve dependencies when retrying failed commits",
    async () => {
      // This test documents expected behavior for the conflict storm fix:
      // When a reactive action's commit fails and it retries, it should
      // preserve its dependency information (not overwrite with empty deps).
      // This ensures topological sorting works correctly during retries.
      //
      // NOTE: This test passes with both buggy and fixed code because line 274
      // immediately re-learns dependencies after each action run, masking the
      // bug in simple scenarios. The real bug manifests only in high-concurrency
      // scenarios (30+ reactive cells) where async commit callbacks race with
      // scheduler execution. See budget-planner integration test for evidence
      // of the fix (conflict storm: 65k errors → 1 error after fix).

      const source = runtime.getCell<number>(
        space,
        "should preserve dependencies source",
        undefined,
        tx,
      );
      source.set(1);

      const intermediate = runtime.getCell<number>(
        space,
        "should preserve dependencies intermediate",
        undefined,
        tx,
      );
      intermediate.set(0);

      const output = runtime.getCell<number>(
        space,
        "should preserve dependencies output",
        undefined,
        tx,
      );
      output.set(0);

      await tx.commit();
      tx = runtime.edit();

      let action1Attempts = 0;
      let action2Attempts = 0;
      const action2Values: number[] = [];
      // Action 1 commits on its third run, and action 2 then re-runs against
      // the value that run wrote. Action 2's second run is the end of that
      // cascade, and resolves `cascadeComplete`.
      const cascadeComplete = defer();

      // Action 1: reads source, writes intermediate (will fail first 2 times)
      const action1: Action = (actionTx) => {
        action1Attempts++;
        const val = source.withTx(actionTx).get();
        intermediate.withTx(actionTx).send(val * 10);

        // Force abort for first 2 attempts to trigger retry logic
        if (action1Attempts <= 2) {
          actionTx.abort("force-abort-action1");
        }
      };

      // Action 2: reads intermediate, writes output (depends on action1)
      const action2: Action = (actionTx) => {
        action2Attempts++;
        const val = intermediate.withTx(actionTx).get();
        action2Values.push(val);
        output.withTx(actionTx).send(val + 5);
        if (action2Attempts === 2) cascadeComplete.resolve();
      };

      // Subscribe both actions with correct dependencies
      runtime.scheduler.subscribe(
        action1,
        {
          reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [
            toMemorySpaceAddress(intermediate.getAsNormalizedFullLink()),
          ],
        },
        {},
      );
      runtime.scheduler.subscribe(
        action2,
        {
          reads: [toMemorySpaceAddress(intermediate.getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
        },
        {},
      );

      // Neither action is an effect, so the scheduler runs one only while
      // something demands what it writes. The sink holds that demand for the
      // whole wait: it reaches action 2 through `output`, and action 1 through
      // action 2's read of `intermediate`.
      const cancel = output.sink(() => {});
      await cascadeComplete.promise;
      // Span the commit of action 2's second run, so a run past the cascade is
      // counted before the assertions read the counters.
      await runtime.scheduler.idleWithPendingCommits();
      cancel();

      // Verify action1 ran 3 times (2 aborts + 1 success)
      expect(action1Attempts).toBe(3);

      // Action2 should run twice in reactive system:
      // 1. Initially when both actions run (sees intermediate=0 since action1 aborts)
      // 2. After action1 succeeds and updates intermediate (sees intermediate=10)
      expect(action2Attempts).toBe(2);
      expect(action2Values).toEqual([0, 10]);

      // Critical assertion: The final state must be correct, proving that
      // dependencies were preserved during retries and topological sort worked.
      expect(intermediate.get()).toBe(10); // 1 * 10
      expect(output.get()).toBe(15); // 10 + 5
    },
  );
});
