import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";

import { Runtime } from "../src/runtime.ts";
import { MAX_RETRIES_FOR_REACTIVE } from "../src/scheduler/constants.ts";
import {
  addInvalidCause,
  markInvalid,
  processStorageNotification,
  type StorageNotificationState,
} from "../src/scheduler/invalidation.ts";
import { NodeRegistry } from "../src/scheduler/node-record.ts";
import { watchReactiveActionCommit } from "../src/scheduler/run.ts";
import { SchedulerTriggerIndex } from "../src/scheduler/trigger-index.ts";
import type { Action } from "../src/scheduler/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  ChangeGroup,
  IExtendedStorageTransaction,
  IMemoryChange,
  IMemorySpaceAddress,
  IStorageTransaction,
  StorageNotification,
} from "../src/storage/interface.ts";
import { describe, expect, it } from "./scheduler-test-utils.ts";

const signer = await Identity.fromPassphrase("scheduler-cfc-trigger-reads");
const space = signer.did() as MemorySpace;

// Identity entity keys resolve scoped addresses against (stage E).
const TEST_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};
const identityThunk = () => TEST_IDENTITY;

function makeChange(
  address: Partial<IMemoryChange["address"]> & { id: string },
): IMemoryChange {
  return {
    address: {
      type: "application/json",
      path: [],
      ...address,
    } as IMemoryChange["address"],
    before: 1,
    after: 2,
  };
}

describe("invalid cause dedup keys", () => {
  it("retains empty paths and embedded delimiters in encounter order", () => {
    const nodes = new NodeRegistry();
    const record = nodes.register(() => {}, "effect");
    const addresses: IMemorySpaceAddress[] = [
      { space, id: "of:cell", path: [] },
      { space, id: "of:cell", path: [""] },
      { space, id: "of:cell", path: ["a\0b", "c"] },
      { space, id: "of:cell", path: ["a", "b\0c"] },
      { space, id: "of:cell\0a", path: ["b"] },
      { space, id: "of:cell", path: ["a\0b"] },
    ];
    for (const address of [...addresses, ...addresses]) {
      addInvalidCause(record, address);
    }
    expect([...record.invalidCauses.values()]).toEqual(addresses);
  });

  it("keeps addresses distinct across scope and ambiguous path joins", () => {
    const action: Action = () => {};
    const nodes = new NodeRegistry();
    const record = nodes.register(action, "effect");

    // Distinct path arrays that a naive join("/") would collapse.
    markInvalid(
      nodes,
      action,
      { ...makeChange({ id: "of:cell", path: ["a", "b"] }).address, space },
    );
    markInvalid(
      nodes,
      action,
      { ...makeChange({ id: "of:cell", path: ["a/b"] }).address, space },
    );
    // Same space/id/path in a different scope is a distinct trigger entity.
    markInvalid(
      nodes,
      action,
      {
        ...makeChange({ id: "of:cell", path: ["a", "b"], scope: "user" })
          .address,
        space,
      },
    );
    // Exact duplicate (scope omitted ≡ scope "space") dedups.
    markInvalid(
      nodes,
      action,
      {
        ...makeChange({ id: "of:cell", path: ["a", "b"], scope: "space" })
          .address,
        space,
      },
    );

    expect(record.invalidCauses.size).toBe(3);
  });
});

function makeNotificationState(args: {
  action: Action;
  triggerIndex: SchedulerTriggerIndex;
  actionChangeGroups?: WeakMap<Action, ChangeGroup>;
}): StorageNotificationState {
  const nodes = new NodeRegistry();
  nodes.register(args.action, "effect");
  return {
    triggerIndex: args.triggerIndex,
    nodes,
    getDiagnosisEnabled: () => false,
    getCollectTriggerTrace: () => false,
    changeGroupToActionId: new Map(),
    recordCausalEdge: () => {},
    actionChangeGroups: args.actionChangeGroups ?? new WeakMap(),
    effects: new Set([args.action]),
    pending: new Set(),
    getActionId: () => "test-action",
    recordCellUpdate: () => {},
    recordTriggerTrace: () => {},
    scheduleWithDebounce: () => {},
    markInvalid: (action, cause) => {
      markInvalid(nodes, action, cause);
    },
    isInvalid: (action) => {
      const record = nodes.get(action);
      return record?.status === "invalid" || record?.status === "never-ran";
    },
    materializerIndex: {
      scopeKeyIdentity: identityThunk,
      materializersByEntity: new Map(),
      effects: new Set(),
      getMaterializerWriteEnvelopes: () => undefined,
      isMaterializer: () => false,
    },
    queueExecution: () => {},
    isRendererInputSource: () => false,
    holdShapedNotification: (_groupKey, _itemKey, _chargeKey, deliver) =>
      deliver(),
  };
}

function makeCommitNotification(
  source: IStorageTransaction,
): StorageNotification {
  // Document-root change: before/after are walked into by the registered
  // trigger paths, so ["value"] must differ between them.
  return {
    type: "commit",
    space,
    changes: [{
      address: {
        id: "of:cell",
        type: "application/json",
        path: [],
      } as IMemoryChange["address"],
      before: { value: 1 },
      after: { value: 2 },
    }],
    source,
  };
}

function makeTriggerIndexFor(action: Action): SchedulerTriggerIndex {
  const triggerIndex = new SchedulerTriggerIndex(identityThunk);
  const read: IMemorySpaceAddress = {
    space,
    scope: "space",
    id: "of:cell",
    path: ["value"],
  };
  triggerIndex.addActionReads(action, [read], []);
  return triggerIndex;
}

describe("trigger reads follow the scheduling decision", () => {
  for (
    const [mode, process] of [
      ["pull", processStorageNotification],
    ] as const
  ) {
    it(`${mode}: skip-own-commit-source records no trigger read`, () => {
      const action: Action = () => {};
      const sourceTx = { sourceAction: action } as IStorageTransaction;
      const state = makeNotificationState({
        action,
        triggerIndex: makeTriggerIndexFor(action),
      });

      process(state, makeCommitNotification(sourceTx));

      expect(state.nodes.get(action)?.invalidCauses.size).toBe(0);
    });

    it(`${mode}: skip-same-change-group records no trigger read`, () => {
      const action: Action = () => {};
      const changeGroup = {} as ChangeGroup;
      const sourceTx = { changeGroup } as IStorageTransaction;
      const actionChangeGroups = new WeakMap<Action, ChangeGroup>();
      actionChangeGroups.set(action, changeGroup);
      const state = makeNotificationState({
        action,
        triggerIndex: makeTriggerIndexFor(action),
        actionChangeGroups,
      });

      process(state, makeCommitNotification(sourceTx));

      expect(state.nodes.get(action)?.invalidCauses.size).toBe(0);
    });

    it(`${mode}: a scheduling change records the trigger read`, () => {
      const action: Action = () => {};
      const state = makeNotificationState({
        action,
        triggerIndex: makeTriggerIndexFor(action),
      });

      process(state, makeCommitNotification({} as IStorageTransaction));

      const causes = [...state.nodes.get(action)!.invalidCauses.values()];
      expect(causes.length).toBe(1);
      expect(causes[0]).toMatchObject({
        space,
        id: "of:cell",
        path: [],
      });
    });
  }
});

describe("trigger reads survive failed runs", () => {
  function watchWith(args: {
    retries?: WeakMap<Action, number>;
    error?: unknown;
    onRestore: () => void;
    onResubscribe?: () => void;
    onMarkInvalid?: () => void;
    onQueueExecution?: () => void;
  }): Promise<void> {
    const action: Action = () => {};
    const tx = {
      tx: {},
      abandonStagedWork: () => {},
    } as unknown as IExtendedStorageTransaction;
    const commitPromise = Promise.resolve(
      { error: args.error } as Awaited<
        ReturnType<IExtendedStorageTransaction["commit"]>
      >,
    );
    return watchReactiveActionCommit({
      canRetry: () => true,
      awaitRetryReadiness: (error) =>
        (error as { readyToRetry?: () => Promise<void> }).readyToRetry?.() ??
          Promise.resolve(),
      action,
      tx,
      log: { reads: [], shallowReads: [], writes: [] },
      retries: args.retries ?? new WeakMap(),
      offBudgetRetries: new WeakMap(),
      pending: new Set(),
      commitPromise,
      resubscribe: () => args.onResubscribe?.(),
      markInvalid: () => args.onMarkInvalid?.(),
      queueExecution: () => args.onQueueExecution?.(),
      getActionId: () => "test-action",
      restoreInvalidCauses: args.onRestore,
    });
  }

  it("restores trigger reads and re-queues a non-conflict retryable error", async () => {
    // Non-conflict, non-permanent errors keep their bounded retry: restore the
    // consumed trigger reads, resubscribe, and re-queue (dirty + pending + tick).
    let restored = 0;
    let queued = 0;
    await watchWith({
      error: new Error("transient"),
      onRestore: () => restored++,
      onQueueExecution: () => queued++,
    });
    expect(restored).toBe(1);
    expect(queued).toBe(1);
  });

  it("a commit conflict re-arms via resubscribe and re-queues after catch-up", async () => {
    // A ConflictError is a stale read: the authoritative version is ahead of
    // this replica. The handler re-arms the subscription (restore + resubscribe)
    // so reader-dirty can re-trigger, waits for the conflict's `readyToRetry`
    // catch-up, then re-queues the action (dirty + pending + tick) so it re-runs
    // against the fresh state. The re-queue is the recovery mechanism: reader-
    // dirty does not re-trigger every conflict (a conflict whose triggering
    // write has already been delivered leaves no future dirty), so relying on it
    // alone would strand the action with its stale committed value.
    const calls: string[] = [];
    const error = Object.assign(new Error("conflict"), {
      name: "ConflictError",
      readyToRetry: () => {
        calls.push("ready");
        return Promise.resolve();
      },
    });
    await watchWith({
      error,
      onRestore: () => calls.push("restore"),
      onResubscribe: () => calls.push("resubscribe"),
      onMarkInvalid: () => calls.push("dirty"),
      onQueueExecution: () => calls.push("queue"),
    });
    expect(calls).toEqual([
      "restore",
      "resubscribe",
      "ready",
      "dirty",
      "queue",
    ]);
  });

  it("a commit conflict bypasses the retry budget (re-queues even when exhausted)", async () => {
    // A non-conflict error stops re-arming once the budget is exhausted (see
    // "does not restore when retries are exhausted"). A conflict must NOT: it is
    // a wait-for-catch-up, not a failure, so it always re-arms and re-queues
    // (restore + resubscribe + dirty + queue) regardless of the budget and never
    // falls into the exhausted-retries branch.
    const error = Object.assign(new Error("conflict"), {
      name: "ConflictError",
    });
    const retries = new WeakMap<Action, number>();
    retries.get = () => MAX_RETRIES_FOR_REACTIVE;
    const calls: string[] = [];
    await watchWith({
      retries,
      error,
      onRestore: () => calls.push("restore"),
      onResubscribe: () => calls.push("resubscribe"),
      onMarkInvalid: () => calls.push("dirty"),
      onQueueExecution: () => calls.push("queue"),
    });
    expect(calls).toEqual(["restore", "resubscribe", "dirty", "queue"]);
  });

  it("re-queues a conflict even when the readyToRetry catch-up rejects", async () => {
    // The catch-up readiness gate rejects by design when the session is closed,
    // revoked, or replaced mid-wait. That abort must not strand the action: it is
    // swallowed and the action is re-queued anyway (restore + resubscribe + dirty
    // + queue) so it re-runs on the next input change or pull.
    const calls: string[] = [];
    const error = Object.assign(new Error("conflict"), {
      name: "ConflictError",
      readyToRetry: () => {
        calls.push("ready");
        return Promise.reject(new Error("session replaced"));
      },
    });
    await watchWith({
      error,
      onRestore: () => calls.push("restore"),
      onResubscribe: () => calls.push("resubscribe"),
      onMarkInvalid: () => calls.push("dirty"),
      onQueueExecution: () => calls.push("queue"),
    });
    expect(calls).toEqual([
      "restore",
      "resubscribe",
      "ready",
      "dirty",
      "queue",
    ]);
  });

  it("re-queues a conflict when readyToRetry throws synchronously", async () => {
    // A readyToRetry that throws synchronously is handled the same as a rejected
    // one — swallowed, and the action re-queued.
    const calls: string[] = [];
    const error = Object.assign(new Error("conflict"), {
      name: "ConflictError",
      readyToRetry: () => {
        calls.push("ready");
        throw new Error("gate threw");
      },
    });
    await watchWith({
      error,
      onRestore: () => calls.push("restore"),
      onResubscribe: () => calls.push("resubscribe"),
      onMarkInvalid: () => calls.push("dirty"),
      onQueueExecution: () => calls.push("queue"),
    });
    expect(calls).toEqual([
      "restore",
      "resubscribe",
      "ready",
      "dirty",
      "queue",
    ]);
  });

  it("requeues primitive retryable errors without retry readiness", async () => {
    let restored = 0;
    let queued = 0;
    await watchWith({
      error: "conflict",
      onRestore: () => restored++,
      onQueueExecution: () => queued++,
    });
    expect(restored).toBe(1);
    expect(queued).toBe(1);
  });

  it("does not restore on successful commit", async () => {
    let restored = 0;
    await watchWith({ onRestore: () => restored++ });
    expect(restored).toBe(0);
  });

  it("does not restore when retries are exhausted", async () => {
    let restored = 0;
    const retries = new WeakMap<Action, number>();
    // watchReactiveActionCommit reads retries via the action it was passed;
    // pre-load every lookup by stubbing get to simulate exhaustion.
    retries.get = () => MAX_RETRIES_FOR_REACTIVE;
    await watchWith({
      retries,
      error: new Error("conflict"),
      onRestore: () => restored++,
    });
    expect(restored).toBe(0);
  });
});

describe("unsubscribe clears pending trigger reads", () => {
  it("drops the pending set so re-subscriptions start clean", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const action: Action = () => {};
      runtime.scheduler.subscribe(
        action,
        { reads: [], shallowReads: [], writes: [] },
        { isEffect: true },
      );
      await runtime.idle();

      const nodes = runtime.scheduler.accessForTestingOnly.nodes;
      const record = nodes.get(action);
      expect(record).toBeDefined();
      addInvalidCause(record!, {
        space,
        scope: "space",
        id: "of:stale",
        path: ["value"],
      });
      expect(record!.invalidCauses.size).toBe(1);

      runtime.scheduler.unsubscribe(action);

      expect(record!.invalidCauses.size).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
