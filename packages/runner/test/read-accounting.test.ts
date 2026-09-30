import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  type ReadAttemptCounts,
  readStatsActive,
  startReadStats,
} from "../src/read-stats.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { createNonReactiveTransaction } from "../src/storage/extended-storage-transaction.ts";
import {
  dispatchQueuedEvent,
  dropQueuedEvent,
  preflightQueuedEventDependencies,
} from "../src/scheduler/events.ts";
import type {
  QueuedEvent,
  ServedEventFailureOutcome,
} from "../src/scheduler/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action, EventHandler } from "../src/scheduler.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { ignoreReadForScheduling } from "../src/storage/reactivity-log.ts";
import {
  RuntimeTelemetryEvent,
  type RuntimeTelemetryMarker,
} from "../src/telemetry.ts";

const signer = await Identity.fromPassphrase("read-accounting");
const space = signer.did();
const otherSpace = (await Identity.fromPassphrase("read-accounting-other"))
  .did();
const schema = {
  type: "object",
  properties: {
    value: { type: "number" },
    absent: { type: "number" },
    items: { type: "array", items: { type: "number" } },
  },
} as const satisfies JSONSchema;

describe("read-accounting", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const tx = runtime.edit();
    runtime.getCell(space, "source", undefined, tx).set({
      value: 7,
      items: [1, 2, 3],
    });
    await tx.commit();
  });

  afterEach(async () => {
    await runtime.idle();
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  it("leaves accounting disabled when attempt observer registration is refused", () => {
    const tx = runtime.edit();
    tx.setReadOnly!("accounting setup test");
    expect(() => startReadStats(tx, () => {})).toThrow();
    expect(readStatsActive).toBe(false);
    tx.clearReadOnly!();
    tx.abort();
    expect(readStatsActive).toBe(false);
  });

  for (const settle of ["commit", "abort"] as const) {
    it(`retains attempt reads through ${settle} without changing the body snapshot`, async () => {
      const tx = runtime.edit();
      const completed: ReadAttemptCounts[] = [];
      const finish = startReadStats(tx, (counts) => completed.push(counts));
      const data = runtime.getCell<{ value: number }>(
        space,
        "source",
        undefined,
        tx,
      )
        .get();
      expect(data.value).toBe(7);
      const body = finish(0);
      expect(body?.proxyAccesses).toBe(1);
      expect(completed).toEqual([]);
      expect(data.value).toBe(7);
      if (settle === "commit") await tx.commit();
      else tx.abort();
      expect(completed).toHaveLength(1);
      expect(completed[0].proxyAccesses).toBe(2);
      expect(body?.distinctDocuments).toBe(1);
      expect(body?.proxyAccesses).toBe(1);
      expect(readStatsActive).toBe(false);
    });
  }

  it("retains a body sample when its action aborts before returning", () => {
    const tx = runtime.edit();
    const completed: ReadAttemptCounts[] = [];
    const finish = startReadStats(tx, (counts) => completed.push(counts));
    const data = runtime.getCell<{ value: number }>(
      space,
      "source",
      undefined,
      tx,
    ).get();
    expect(data.value).toBe(7);
    tx.abort();
    expect(completed).toHaveLength(1);
    expect(completed[0].proxyAccesses).toBe(1);
    expect(finish(0)?.proxyAccesses).toBe(1);
    expect(readStatsActive).toBe(false);
  });

  it("disables body-only probes when the body ends", () => {
    const tx = runtime.edit();
    const finish = startReadStats(tx);
    const data = runtime.getCell<{ value: number }>(
      space,
      "source",
      undefined,
      tx,
    )
      .get();
    expect(data.value).toBe(7);
    expect(finish(0)?.proxyAccesses).toBe(1);
    expect(data.value).toBe(7);
    expect(readStatsActive).toBe(false);
    tx.abort();
  });

  it("records event bodies and preflights as independent completed attempts", async () => {
    runtime.scheduler.setReadStatsEnabled(true, { attempts: true });
    const markers: RuntimeTelemetryMarker[] = [];
    runtime.telemetry.addEventListener("telemetry", (event) => {
      if (event instanceof RuntimeTelemetryEvent) markers.push(event.marker);
    });
    const eventCell = runtime.getCell(space, "budget-event");
    const read = (tx: IExtendedStorageTransaction) => {
      const data = runtime.getCell<{ value: number }>(
        space,
        "source",
        undefined,
        tx,
      ).get();
      expect(data.value).toBe(7);
    };
    const handler: EventHandler = (tx) => {
      read(tx);
      read(tx);
    };
    handler.populateDependencies = (tx) => read(tx);
    runtime.scheduler.addEventHandler(
      handler,
      eventCell.getAsNormalizedFullLink(),
    );
    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      undefined,
    );
    await runtime.settled();
    const attempts = markers.filter((m) => m.type === "scheduler.read-attempt");
    expect(
      attempts.filter((m) => m.kind === "event").map((m) =>
        m.reads.proxyAccesses
      ),
    ).toEqual([2]);
    const preflights = attempts.filter((m) => m.kind === "preflight");
    expect(preflights.length).toBeGreaterThan(0);
    expect(preflights.every((m) => m.reads.proxyAccesses === 1)).toBe(true);
  });

  it("accounts for implementation selection with preflight and event reads", async () => {
    runtime.scheduler.setReadStatsEnabled(true, { attempts: true });
    const markers: RuntimeTelemetryMarker[] = [];
    runtime.telemetry.addEventListener("telemetry", (event) => {
      if (event instanceof RuntimeTelemetryEvent) markers.push(event.marker);
    });
    const read = (tx: IExtendedStorageTransaction) =>
      runtime.getCell<{ value: number }>(space, "source", undefined, tx).get()
        .value;
    const handler: EventHandler = (tx) => {
      expect(read(tx)).toBe(7);
      expect(read(tx)).toBe(7);
    };
    handler.implementationSelection = {
      key: "accounted-implementation",
      matches: (tx) => read(tx) === 7,
    };
    handler.populateDependencies = (tx) => {
      expect(read(tx)).toBe(7);
    };
    const link = runtime.getCell(space, "guarded-budget-event")
      .getAsNormalizedFullLink();
    runtime.scheduler.addEventHandler(handler, link);
    runtime.scheduler.queueEvent(link, undefined);
    await runtime.settled();
    const attempts = markers.filter((m) => m.type === "scheduler.read-attempt");
    expect(
      attempts.filter((m) => m.kind === "event").map((m) =>
        m.reads.proxyAccesses
      ),
    ).toEqual([3]);
    const preflights = attempts.filter((m) => m.kind === "preflight");
    expect(preflights.length).toBeGreaterThan(0);
    expect(preflights.every((m) => m.reads.proxyAccesses === 2)).toBe(true);
    expect(readStatsActive).toBe(false);
  });

  it("completes an accounted event when selection throws after presync", async () => {
    runtime.scheduler.setReadStatsEnabled(true, { attempts: true });
    const markers: RuntimeTelemetryMarker[] = [];
    runtime.telemetry.addEventListener("telemetry", (event) => {
      if (event instanceof RuntimeTelemetryEvent) markers.push(event.marker);
    });
    let presynced = false;
    let invoked = false;
    const failure = new Error("selection failed after presync");
    const handler: EventHandler = () => {
      invoked = true;
    };
    handler.implementationSelection = {
      key: "throwing-selection",
      matches: (tx) => {
        const value =
          runtime.getCell<{ value: number }>(space, "source", undefined, tx)
            .get().value;
        if (presynced) throw failure;
        return value === 7;
      },
    };
    handler.presyncInputs = () => {
      presynced = true;
      return Promise.resolve();
    };
    const link = runtime.getCell(space, "throwing-guarded-budget-event")
      .getAsNormalizedFullLink();
    const commits: IExtendedStorageTransaction[] = [];
    const outcomes: ServedEventFailureOutcome[] = [];
    runtime.scheduler.addEventHandler(handler, link);
    runtime.scheduler.queueEvent(
      link,
      undefined,
      false,
      (tx) => commits.push(tx),
      false,
      {
        served: { onFailure: (outcome) => outcomes.push(outcome) },
      },
    );
    await runtime.settled();
    expect(invoked).toBe(false);
    expect(commits).toHaveLength(1);
    expect(commits[0].status().status).toBe("error");
    expect(outcomes).toEqual([{ kind: "error", message: failure.message }]);
    expect(
      markers.filter((m) => m.type === "scheduler.read-attempt")
        .filter((m) => m.kind === "event")
        .map((m) => m.reads.proxyAccesses),
    ).toEqual([1]);
    expect(readStatsActive).toBe(false);
  });

  for (const enabled of [false, true]) {
    it(`closes rejected presync reads with accounting ${enabled ? "enabled" : "disabled"}`, async () => {
      runtime.scheduler.setReadStatsEnabled(enabled, { attempts: true });
      const markers: RuntimeTelemetryMarker[] = [];
      runtime.telemetry.addEventListener("telemetry", (event) => {
        if (event instanceof RuntimeTelemetryEvent) markers.push(event.marker);
      });
      let invoked = false;
      let presyncTx: IExtendedStorageTransaction | undefined;
      const handler: EventHandler = () => {
        invoked = true;
      };
      handler.presyncInputs = (_event, _identity, tx) => {
        presyncTx = tx;
        expect(
          runtime.getCell<{ value: number }>(space, "source", undefined, tx)
            .get().value,
        )
          .toBe(7);
        return Promise.reject(new Error("input sync failed"));
      };
      const link = runtime.getCell(space, "presync-budget-event")
        .getAsNormalizedFullLink();
      runtime.scheduler.addEventHandler(handler, link);
      runtime.scheduler.queueEvent(link, undefined);
      await runtime.settled();
      expect(invoked).toBe(true);
      expect(presyncTx?.status().status).toBe("error");
      expect(
        markers.filter((m) => m.type === "scheduler.read-attempt")
          .filter((m) => m.kind === "presync")
          .map((m) => m.reads.proxyAccesses),
      ).toEqual(enabled ? [1] : []);
      expect(readStatsActive).toBe(false);
    });
  }

  it("settles queued events after preflight setup fails", async () => {
    runtime.scheduler.setReadStatsEnabled(true, { attempts: true });
    const failure = new Error("preflight setup failed");
    const errors: Error[] = [];
    runtime.scheduler.onError((error) => errors.push(error));
    const beginReadAttempt = runtime.scheduler.beginReadAttempt;
    using _begin = stub(
      runtime.scheduler,
      "beginReadAttempt",
      function (...args) {
        beginReadAttempt.apply(this, args);
        if (args[1] === "preflight") throw failure;
      },
    );
    let invoked = false;
    const handler: EventHandler = () => {
      invoked = true;
    };
    handler.populateDependencies = () => {};
    const link = runtime.getCell(space, "preflight-setup-event")
      .getAsNormalizedFullLink();
    const commits: IExtendedStorageTransaction[] = [];
    const outcomes: ServedEventFailureOutcome[] = [];
    runtime.scheduler.addEventHandler(handler, link);
    runtime.scheduler.queueEvent(
      link,
      undefined,
      false,
      (tx) => commits.push(tx),
      false,
      {
        served: { onFailure: (outcome) => outcomes.push(outcome) },
      },
    );
    await runtime.settled();
    expect(invoked).toBe(false);
    expect(errors).toEqual([failure]);
    expect(commits).toHaveLength(1);
    expect(commits[0].status().status).toBe("error");
    expect(outcomes).toHaveLength(1);
    expect(runtime.scheduler.accessForTestingOnly.eventQueue).toEqual([]);
    expect(readStatsActive).toBe(false);
  });

  it("settles queued events after dispatch setup fails", async () => {
    runtime.scheduler.setReadStatsEnabled(true, { attempts: true });
    const failure = new Error("dispatch setup failed");
    const errors: Error[] = [];
    runtime.scheduler.onError((error) => errors.push(error));
    const beginReadAttempt = runtime.scheduler.beginReadAttempt;
    using _begin = stub(
      runtime.scheduler,
      "beginReadAttempt",
      function (...args) {
        beginReadAttempt.apply(this, args);
        if (args[1] === "event" && errors.length === 0) throw failure;
      },
    );
    let invoked = false;
    const handler: EventHandler = () => {
      invoked = true;
    };
    handler.populateDependencies = () => {};
    const link = runtime.getCell(space, "dispatch-setup-event")
      .getAsNormalizedFullLink();
    const commits: IExtendedStorageTransaction[] = [];
    const outcomes: ServedEventFailureOutcome[] = [];
    runtime.scheduler.addEventHandler(handler, link);
    runtime.scheduler.queueEvent(
      link,
      undefined,
      false,
      (tx) => commits.push(tx),
      false,
      {
        served: { onFailure: (outcome) => outcomes.push(outcome) },
      },
    );
    await runtime.settled();
    expect(invoked).toBe(false);
    expect(errors).toEqual([failure]);
    expect(commits).toHaveLength(1);
    expect(commits[0].status().status).toBe("error");
    expect(outcomes).toHaveLength(1);
    expect(runtime.scheduler.accessForTestingOnly.eventQueue).toEqual([]);
    expect(readStatsActive).toBe(false);
    runtime.scheduler.queueEvent(link, undefined);
    await runtime.settled();
    expect(invoked).toBe(true);
    expect(errors).toEqual([failure]);
    expect(runtime.scheduler.accessForTestingOnly.eventQueue).toEqual([]);
    expect(readStatsActive).toBe(false);
  });

  it("closes read-only preflight accounting when error reporting throws", () => {
    runtime.scheduler.setReadStatsEnabled(true, { attempts: true });
    const markers: RuntimeTelemetryMarker[] = [];
    runtime.telemetry.addEventListener("telemetry", (event) => {
      if (event instanceof RuntimeTelemetryEvent) markers.push(event.marker);
    });
    const failure = new Error("dependency inspection failed");
    const commits: IExtendedStorageTransaction[] = [];
    const outcomes: ServedEventFailureOutcome[] = [];
    const handler = Object.assign(() => {}, {
      populateDependencies: (tx: IExtendedStorageTransaction) => {
        expect(
          runtime.getCell<{ value: number }>(space, "source", undefined, tx)
            .get().value,
        ).toBe(7);
        throw failure;
      },
    });
    const access = runtime.scheduler.accessForTestingOnly;
    const queued: QueuedEvent = {
      id: "preflight-fault",
      enqueueSeq: 0,
      eventLink: runtime.getCell(space, "source").getAsNormalizedFullLink(),
      action: handler,
      handler,
      event: undefined,
      retry: false,
      onCommit: (tx) => {
        commits.push(tx);
      },
      served: {
        onFailure: (outcome) => {
          outcomes.push(outcome);
        },
      },
    };
    access.eventQueue.push(queued);
    const state: Parameters<typeof preflightQueuedEventDependencies>[0] = {
      ...access.eventExecutionState,
      nodes: access.nodes,
      pending: access.pending,
      pendingActions: new Set(),
      eventBlockingDeps: new Set(),
      handleError: () => {
        throw new Error("error reporter failed");
      },
      setEventPreflightTraceContext: () => {},
      collectInvalidUpstreamForLog: () => false,
      isDebouncedComputationWaiting: () => false,
      getNextDebounceRunTime: () => undefined,
      getNextEligibleRunTime: () => undefined,
      scheduleWake: () => {},
      dropEvent: (event, reason) =>
        dropQueuedEvent(access.eventExecutionState, event, reason),
    };
    expect(preflightQueuedEventDependencies(state, queued).shouldSkipEvent)
      .toBe(true);
    expect(
      markers.filter((m) => m.type === "scheduler.read-attempt").map((m) =>
        m.reads.proxyAccesses
      ),
    ).toEqual([1]);
    expect(readStatsActive).toBe(false);
    expect(access.eventQueue).toEqual([]);
    expect(commits).toHaveLength(1);
    expect(commits[0].status().status).toBe("error");
    expect(outcomes).toHaveLength(1);
  });

  it("completes an event attempt when setup throws before invoking the handler", async () => {
    runtime.scheduler.setReadStatsEnabled(true, { attempts: true });
    const markers: RuntimeTelemetryMarker[] = [];
    runtime.telemetry.addEventListener("telemetry", (event) => {
      if (event instanceof RuntimeTelemetryEvent) markers.push(event.marker);
    });
    const commits: IExtendedStorageTransaction[] = [];
    const outcomes: ServedEventFailureOutcome[] = [];
    const reported: Error[] = [];
    const released: QueuedEvent[] = [];
    const origin = runtime.edit();
    let dispatchedTx: IExtendedStorageTransaction | undefined;
    let invoked = false;
    const handler = () => {
      invoked = true;
    };
    const queued: QueuedEvent = {
      id: "setup-fault",
      enqueueSeq: 0,
      eventLink: runtime.getCell(space, "fault-event")
        .getAsNormalizedFullLink(),
      action: handler,
      handler,
      event: undefined,
      retry: false,
      originTx: origin,
      onCommit: (tx) => {
        commits.push(tx);
      },
      served: {
        onFailure: (outcome) => {
          outcomes.push(outcome);
        },
      },
    };
    const access = runtime.scheduler.accessForTestingOnly;
    access.eventQueue.push(queued);
    const failure = new Error("injected event setup failure");
    using _stamp = stub(runtime, "stampServerRun", (tx) => {
      dispatchedTx = tx;
      expect(
        runtime.getCell<{ value: number }>(space, "source", undefined, tx).get()
          .value,
      ).toBe(7);
      throw failure;
    });
    await dispatchQueuedEvent({
      ...access.eventExecutionState,
      handleError: (error) => {
        reported.push(error);
        throw new Error("error reporter failed");
      },
      releaseLineageEvent: (_tx, event) => {
        released.push(event);
      },
    }, queued);
    expect(invoked).toBe(false);
    expect(
      markers.filter((m) => m.type === "scheduler.read-attempt").map((m) =>
        m.reads.proxyAccesses
      ),
    ).toEqual([1]);
    expect(readStatsActive).toBe(false);
    expect(commits).toEqual([dispatchedTx]);
    expect(dispatchedTx?.status().status).toBe("error");
    expect(reported).toEqual([failure]);
    expect(released).toEqual([queued]);
    expect(outcomes).toEqual([{ kind: "error", message: failure.message }]);
    expect(access.eventQueue).toEqual([]);
    expect(queued.finalOutcomeNotified).toBe(true);
    origin.abort();
  });

  it("completes an edit attempt when commit preparation throws", () => {
    runtime.scheduler.setReadStatsEnabled(true, { attempts: true });
    const attempts: RuntimeTelemetryMarker[] = [];
    runtime.telemetry.addEventListener("telemetry", (event) => {
      if (event instanceof RuntimeTelemetryEvent) attempts.push(event.marker);
    });
    const read = (tx: IExtendedStorageTransaction) => {
      expect(
        runtime.getCell<{ value: number }>(space, "source", undefined, tx).get()
          .value,
      ).toBe(7);
    };
    using _prepare = stub(runtime, "prepareTxForCommit", (tx) => {
      read(tx);
      throw new Error("injected preparation failure");
    });
    expect(() => runtime.editWithRetry(read, 0)).toThrow(
      "injected preparation failure",
    );
    expect(
      attempts.filter((m) => m.type === "scheduler.read-attempt").map((m) =>
        m.reads.proxyAccesses
      ),
    ).toEqual([2]);
    expect(readStatsActive).toBe(false);
  });

  it("includes successful and failed editWithRetry bodies in attempt totals", async () => {
    runtime.scheduler.setReadStatsEnabled(true, { attempts: true });
    const markers: RuntimeTelemetryMarker[] = [];
    runtime.telemetry.addEventListener("telemetry", (event) => {
      if (event instanceof RuntimeTelemetryEvent) markers.push(event.marker);
    });
    for (const fail of [false, true]) {
      const result = await runtime.editWithRetry((tx) => {
        const data = runtime.getCell<{ value: number }>(
          space,
          "source",
          undefined,
          tx,
        ).get();
        expect(data.value).toBe(7);
        if (fail) throw new Error("measured edit failure");
      });
      expect(result.error !== undefined).toBe(fail);
    }
    expect(
      markers.filter((m) => m.type === "scheduler.read-attempt")
        .filter((m) => m.kind === "editWithRetry")
        .map((m) => m.reads.proxyAccesses),
    ).toEqual([1, 1]);
  });

  it("shares counts through nonreactive wrappers without sharing across transactions", () => {
    const tx = runtime.edit();
    const other = runtime.edit();
    const finish = startReadStats(tx);
    const finishOther = startReadStats(other);
    const wrapped = createNonReactiveTransaction(tx);
    expect(
      runtime.getCell<{ value: number }>(space, "source", undefined, wrapped)
        .get().value,
    ).toBe(7);
    expect(finishOther(0)).toEqual({
      proxyAccesses: 0,
      linkResolutions: 0,
      distinctDocuments: 0,
      registeredDependencies: 0,
    });
    expect(finish(0).proxyAccesses).toBe(1);
    tx.abort();
    other.abort();
  });

  it("preserves the read log and subscription paths when accounting is enabled", () => {
    const read = (enabled: boolean) => {
      const tx = runtime.edit();
      tx.markLazyMaterialize(true);
      const finish = enabled ? startReadStats(tx) : undefined;
      const data = runtime.getCell<{ value: number; items: number[] }>(
        space,
        "source",
        schema,
        tx,
      ).get();
      const result = data.value +
        data.items.reduce((sum, value) => sum + value, 0);
      const before = tx.getReactivityLog?.();
      expect(before).toBeDefined();
      const counts = finish?.(0);
      const after = tx.getReactivityLog?.();
      expect(after).toEqual(before);
      tx.abort();
      return { result, log: after, counts };
    };
    const disabled = read(false);
    const enabled = read(true);
    expect(enabled.result).toBe(13);
    expect(enabled.result).toBe(disabled.result);
    expect(enabled.log).toEqual(disabled.log);
    expect(disabled.counts).toBeUndefined();
    expect(enabled.counts!.proxyAccesses).toBe(5);
  });

  it("isolates measured reads from two runtimes sharing storage", async () => {
    const second = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const left = runtime.edit();
    const right = second.edit();
    const finishLeft = startReadStats(left);
    const finishRight = startReadStats(right);
    try {
      const a = runtime.getCell<{ value: number }>(
        space,
        "source",
        undefined,
        left,
      ).get();
      const b = second.getCell<{ value: number }>(
        space,
        "source",
        undefined,
        right,
      ).get();
      expect(a.value + b.value + b.value).toBe(21);
      expect(finishLeft(0).proxyAccesses).toBe(1);
      expect(finishRight(0).proxyAccesses).toBe(2);
    } finally {
      left.abort();
      right.abort();
      await second.dispose({ closeStorage: false });
    }
  });

  it("attributes standing proxy reads to the selected fallback transaction", () => {
    const original = runtime.edit();
    const data = runtime.getCell<{ value: number; items: number[] }>(
      space,
      "source",
      undefined,
      original,
    ).get();
    const items = data.items;
    const finishOriginal = startReadStats(original);
    original.abort();
    const fallback = runtime.edit();
    const finishFallback = startReadStats(fallback);
    using _readTx = stub(
      runtime,
      "readTx",
      (tx) => tx?.status().status === "ready" ? tx : fallback,
    );
    try {
      expect(data.value).toBe(7);
      expect(items.length).toBe(3);
      expect([...items]).toEqual([1, 2, 3]);
      expect(items.map((n) => n * 2)).toEqual([2, 4, 6]);
      expect(Object.getOwnPropertyDescriptor(data, "value")!.get!.call(data))
        .toBe(7);
      expect(Object.getOwnPropertyDescriptor(items, "length")!.value).toBe(3);
      expect(finishFallback(0).proxyAccesses).toBe(10);
      expect(finishOriginal(0).proxyAccesses).toBe(0);
    } finally {
      finishOriginal(0);
      finishFallback(0);
      fallback.abort();
    }
  });

  it("counts missing schema-array index reads", () => {
    const tx = runtime.edit();
    tx.markLazyMaterialize();
    const data = runtime.getCell<{ items: number[] }>(
      space,
      "source",
      schema,
      tx,
    ).get();
    const items = data.items;
    const finish = startReadStats(tx);
    try {
      expect(items[99]).toBeUndefined();
      expect(finish(0).proxyAccesses).toBe(1);
    } finally {
      finish(0);
      tx.abort();
    }
  });

  it("compacts scheduling dependencies separately from recorded documents", async () => {
    runtime.scheduler.setReadStatsEnabled(true);
    const cell = runtime.getCell(space, "source");
    const link = cell.getAsNormalizedFullLink();
    const action: Action = (tx) => {
      const address = {
        space,
        id: link.id,
        scope: "space" as const,
        path: ["value", "value"],
      };
      tx.read(address);
      tx.read(address);
      tx.read({ ...address, path: ["value"] }, { nonRecursive: true });
      tx.read({ ...address, path: ["value", "items"] }, {
        meta: ignoreReadForScheduling,
      });
    };
    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    runtime.scheduler.queueExecution();
    await runtime.idle();
    expect(runtime.scheduler.getActionStats(action)!.lastRunReads!).toEqual({
      proxyAccesses: 0,
      linkResolutions: 0,
      distinctDocuments: 1,
      registeredDependencies: 2,
    });
    runtime.scheduler.unsubscribe(action);
  });

  it("records reads before an action throws and isolates an asynchronous run", async () => {
    const errors: Error[] = [];
    await runtime.dispose({ closeStorage: false });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      errorHandlers: [(error) => errors.push(error)],
    });
    runtime.scheduler.setReadStatsEnabled(true);
    const barrier = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const action: Action = async (tx) => {
      const data = runtime.getCell<{ value: number }>(
        space,
        "source",
        undefined,
        tx,
      ).get();
      expect(data.value).toBe(7);
      entered.resolve();
      await barrier.promise;
      expect(data.value).toBe(7);
      throw new Error("measured failure");
    };
    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    runtime.scheduler.queueExecution();
    await entered.promise;
    const other = runtime.edit();
    runtime.getCell<{ value: number }>(space, "source", undefined, other).get()
      .value;
    other.abort();
    runtime.scheduler.setReadStatsEnabled(false);
    barrier.resolve();
    await runtime.idle();
    expect(errors.some((e) => e.message === "measured failure")).toBe(true);
    expect(
      runtime.scheduler.getActionStats(action)!.lastRunReads!.proxyAccesses,
    )
      .toBe(2);
    runtime.scheduler.unsubscribe(action);
  });

  it("keeps the initial accounting setting across fan-out instances", async () => {
    using _demanders = stub(runtime, "serverRunDemandersFor", () => [
      { principal: space },
      { principal: otherSpace },
    ]);
    const scopeStubs: Stub[] = [];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let runs = 0;
    const action = Object.assign(async (tx: IExtendedStorageTransaction) => {
      scopeStubs.push(stub(tx, "getNarrowestReadScope", (): "user" => "user"));
      const value = runtime.getCell<{ value: number }>(
        space,
        "source",
        undefined,
        tx,
      ).get();
      expect(value.value).toBe(7);
      if (++runs === 1) {
        entered.resolve();
        await release.promise;
      }
    }, { schedulerObservationIdentity: { pieceRootId: "read-accounting" } });
    runtime.scheduler.setReadStatsEnabled(true);
    const running = runtime.scheduler.run(action);
    try {
      await entered.promise;
      runtime.scheduler.setReadStatsEnabled(false);
      release.resolve();
      await running;
      expect(runs).toBe(2);
      const stats = runtime.scheduler.getActionStats(action)!;
      expect(stats.reads!.proxyAccesses).toBe(2);
      expect(stats.reads!.proxyAccesses).toBe(2);
    } finally {
      release.resolve();
      await running;
      for (const scope of scopeStubs) scope.restore();
    }
  });

  it("records each enabled scheduler run and preserves unmeasured run counts", async () => {
    const markers: RuntimeTelemetryMarker[] = [];
    const listener = (event: Event) => {
      if (event instanceof RuntimeTelemetryEvent) markers.push(event.marker);
    };
    runtime.telemetry.addEventListener("telemetry", listener);
    const action: Action = (tx) => {
      const value = runtime.getCell<{ value: number }>(
        space,
        "source",
        undefined,
        tx,
      ).get();
      expect(value.value + value.value).toBe(14);
    };
    const run = async () => {
      runtime.scheduler.subscribe(action, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });
      runtime.scheduler.queueExecution();
      await runtime.idle();
    };
    try {
      await run();
      expect(runtime.scheduler.getActionStats(action)!.reads).toBeUndefined();
      runtime.scheduler.setReadStatsEnabled(true);
      await run();
      await run();
      const stats = runtime.scheduler.getActionStats(action)!;
      expect(stats.runCount).toBe(3);
      expect(stats.reads!.proxyAccesses).toBe(4);
      expect(stats.lastRunReads!.proxyAccesses).toBe(2);
      expect(stats.reads!.proxyAccesses).toBe(4);
      expect(stats.lastRunReads!.registeredDependencies).toBeGreaterThan(0);
      const measured = markers.filter((m) =>
        m.type === "scheduler.run.complete" && m.reads !== undefined
      );
      expect(measured).toHaveLength(2);
      runtime.scheduler.setReadStatsEnabled(false);
      await run();
      expect(runtime.scheduler.getActionStats(action)!.reads!.proxyAccesses)
        .toBe(4);
      expect(runtime.scheduler.getActionStats(action)!.lastRunReads)
        .toBeUndefined();
    } finally {
      runtime.telemetry.removeEventListener("telemetry", listener);
      runtime.scheduler.unsubscribe(action);
    }
  });
});
