import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { ActionStats } from "../src/telemetry.ts";
import {
  AUTO_DEBOUNCE_DELAY_MS,
  AUTO_DEBOUNCE_MIN_RUNS,
  AUTO_DEBOUNCE_THRESHOLD_MS,
} from "../src/scheduler/constants.ts";
import { SchedulerGates } from "../src/scheduler/gates.ts";
import { NodeRegistry } from "../src/scheduler/node-record.ts";
import { appendActionRunTrace } from "../src/scheduler/run.ts";
import type {
  Action,
  ActionRunTraceEntry,
  ReactivityLog,
} from "../src/scheduler/types.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";

function actionStats(
  lastRunTimestamp = performance.now(),
): ActionStats {
  return {
    runCount: AUTO_DEBOUNCE_MIN_RUNS,
    totalTime: AUTO_DEBOUNCE_THRESHOLD_MS * AUTO_DEBOUNCE_MIN_RUNS,
    averageTime: AUTO_DEBOUNCE_THRESHOLD_MS,
    lastRunTime: AUTO_DEBOUNCE_THRESHOLD_MS,
    lastRunTimestamp,
  };
}

function makeGates(options: {
  nodes?: NodeRegistry;
  stats?: Map<string, ActionStats>;
  disposed?: () => boolean;
  queued?: () => void;
} = {}) {
  const nodes = options.nodes ?? new NodeRegistry();
  const stats = options.stats ?? new Map<string, ActionStats>();
  const gates = new SchedulerGates({
    nodes,
    actionStats: stats,
    getActionId: (action) => action.name,
    isDisposed: options.disposed ?? (() => false),
    queueExecution: options.queued ?? (() => {}),
  });
  return { gates, nodes, stats };
}

describe("scheduler run gates", () => {
  it("keeps a staged initial hold until registration adopts it", () => {
    const action: Action = function stagedInitialHold() {};
    let queued = 0;
    const { gates, nodes } = makeGates({ queued: () => queued++ });
    const deadline = performance.now() + 30_000;

    try {
      gates.holdInitialRun(action, deadline);

      // A release before registration has no live record to release. Once the
      // registration adopts the staged gate, the same hold is authoritative.
      gates.releaseInitialRunHold(action);
      const node = nodes.register(action, "computation");
      gates.adopt(action);
      expect(gates.eligibleAt(node)).toBe(deadline);
      expect(gates.isEligible(node)).toBe(false);

      gates.releaseInitialRunHold(action);
      expect(gates.isEligible(node)).toBe(true);
      expect(queued).toBe(1);
    } finally {
      gates.cancelWake();
    }
  });

  it("shortens an armed debounce and restores immediate scheduling", () => {
    const action: Action = function adjustableDebounce() {};
    let sharedWakeRecomputes = 0;
    let immediateQueues = 0;
    const { gates, nodes } = makeGates({
      queued: () => sharedWakeRecomputes++,
    });
    nodes.register(action, "computation");
    nodes.setStatus(action, "clean");
    const pending = new Set<Action>();

    try {
      gates.setDebounce(action, 30_000);
      gates.scheduleWithDebounce(action, {
        pending,
        queueExecution: () => immediateQueues++,
        logDebounce: () => {},
      });
      const originalReadyAt = gates.getNextDebounceRunTime(action, {
        computations: nodes.computations,
        effects: nodes.effects,
        isInvalid: () => true,
      });
      expect(originalReadyAt).toBeDefined();

      gates.setDebounce(action, 10_000);
      const shortenedReadyAt = gates.getNextDebounceRunTime(action, {
        computations: nodes.computations,
        effects: nodes.effects,
        isInvalid: () => true,
      });
      expect(shortenedReadyAt).toBeLessThan(originalReadyAt!);
      expect(sharedWakeRecomputes).toBe(1);

      gates.setNoDebounce(action, true);
      expect(gates.getNoDebounce(action)).toBe(true);
      gates.setNoDebounce(action, false);
      expect(gates.getNoDebounce(action)).toBeUndefined();

      gates.clearDebounce(action);
      gates.scheduleWithDebounce(action, {
        pending,
        queueExecution: () => immediateQueues++,
        logDebounce: () => {},
      });
      expect(pending.has(action)).toBe(true);
      expect(immediateQueues).toBe(1);
    } finally {
      gates.cancelWake();
    }
  });

  it("does not report a debounce wait after the computation becomes clean", () => {
    const action: Action = function cleanDebouncedComputation() {};
    const { gates, nodes } = makeGates();
    nodes.register(action, "computation");
    nodes.setStatus(action, "clean");
    gates.setDebounce(action, 1_000);

    expect(gates.getNextDebounceRunTime(action, {
      computations: nodes.computations,
      effects: nodes.effects,
      isInvalid: () => false,
    })).toBeUndefined();
  });

  it("re-arms throttle and auto-debounce policy from completed-run stats", () => {
    const action: Action = function measuredEffect() {};
    const stats = new Map<string, ActionStats>();
    const { gates, nodes } = makeGates({ stats });
    const node = nodes.register(action, "effect");

    expect(gates.maybeAutoDebounce(action, {
      canAutomaticallyDebounce: () => true,
    })).toBeUndefined();

    stats.set(action.name, actionStats());
    gates.setThrottle(action, 5_000);
    const update = gates.onRunCompleted(node, {
      canAutomaticallyDebounce: () => true,
    });

    expect(gates.isThrottled(action)).toBe(true);
    expect(update).toEqual({
      actionId: action.name,
      averageTime: AUTO_DEBOUNCE_THRESHOLD_MS,
      delayMs: AUTO_DEBOUNCE_DELAY_MS,
      thresholdMs: AUTO_DEBOUNCE_THRESHOLD_MS,
    });
    expect(gates.getDebounce(action)).toBe(AUTO_DEBOUNCE_DELAY_MS);
  });

  it("recomputes eligibility when a throttle is shortened", () => {
    const action: Action = function adjustableThrottle() {};
    const eligibleAction: Action = function alreadyEligible() {};
    const unknownAction: Action = function unknownAction() {};
    const now = performance.now();
    const stats = new Map<string, ActionStats>([
      [action.name, actionStats(now)],
    ]);
    let queued = 0;
    const { gates, nodes } = makeGates({ stats, queued: () => queued++ });
    const node = nodes.register(action, "computation");
    const eligibleNode = nodes.register(eligibleAction, "computation");

    gates.setThrottle(action, 30_000);
    const originalReadyAt = gates.getNextEligibleRunTime(action, now)!;
    gates.setThrottle(action, 20_000);
    const shortenedReadyAt = gates.getNextEligibleRunTime(action, now)!;

    expect(shortenedReadyAt).toBeLessThan(originalReadyAt);
    expect(queued).toBe(1);
    expect(gates.isEligible(node, now)).toBe(false);
    expect(gates.isEligible(node, shortenedReadyAt)).toBe(true);
    expect(gates.isThrottled(unknownAction, now)).toBe(false);
    expect(gates.getNextEligibleRunTime(unknownAction, now)).toBeUndefined();
    expect(gates.nextWake([eligibleNode, node], now)).toBe(shortenedReadyAt);

    // Clearing an unknown action is deliberately a no-op; clearing the live
    // action makes it immediately eligible again and recomputes the wake.
    gates.clearThrottle(unknownAction);
    gates.clearThrottle(action);
    expect(gates.isEligible(node, now)).toBe(true);
    expect(queued).toBe(2);
  });

  it("releases debounce and throttle readiness for a scheduler-owed retry, keeping the backoff", () => {
    const action: Action = function retriedComputation() {};
    const unknownAction: Action = function neverRegistered() {};
    const now = performance.now();
    const stats = new Map<string, ActionStats>([
      [action.name, actionStats(now)],
    ]);
    let queued = 0;
    const { gates, nodes } = makeGates({ stats, queued: () => queued++ });
    const node = nodes.register(action, "computation");
    nodes.setStatus(action, "invalid");
    gates.setDebounce(action, 30_000);
    gates.onInvalidated(node, now, {
      computations: nodes.computations,
      effects: nodes.effects,
      isInvalid: () => true,
      pending: new Set<Action>(),
      queueExecution: () => {},
      logDebounce: () => {},
      shouldDebounceFirstRun: () => false,
    });
    gates.setThrottle(action, 30_000);
    node.gate.backoffUntil = now + 30_000;
    expect(gates.isEligible(node, now)).toBe(false);
    const queuedBefore = queued;

    // Unknown action: a no-op. Registered action: both readiness fields go,
    // the wake is recomputed, the backoff and the policies stay.
    gates.releaseForRetry(unknownAction);
    expect(queued).toBe(queuedBefore);
    gates.releaseForRetry(action);
    expect(queued).toBe(queuedBefore + 1);
    expect(gates.hasActiveDebounceTimer(action)).toBe(false);
    expect(gates.isThrottled(action, now)).toBe(false);
    expect(gates.eligibleAt(node)).toBe(now + 30_000);
    expect(gates.getDebounce(action)).toBe(30_000);
    expect(gates.getThrottle(action)).toBe(30_000);

    // Nothing armed: nothing to recompute.
    delete node.gate.backoffUntil;
    gates.releaseForRetry(action);
    expect(queued).toBe(queuedBefore + 1);
    expect(gates.isEligible(node, now)).toBe(true);
  });

  it("does not arm wake timers after scheduler disposal", () => {
    let queued = 0;
    const { gates } = makeGates({
      disposed: () => true,
      queued: () => queued++,
    });

    gates.scheduleWake(performance.now() + 30_000);

    expect(gates.hasWakeTimer()).toBe(false);
    expect(queued).toBe(0);
  });

  it("bounds action-run diagnostics while preserving parent and write data", () => {
    const parent: Action = function traceParent() {};
    const action: Action = function traceChild() {};
    const nodes = new NodeRegistry();
    nodes.register(parent, "computation");
    nodes.register(action, "effect", parent);
    const space = "did:key:scheduler-run-gates" as MemorySpace;
    const declaredWrite: IMemorySpaceAddress = {
      space,
      id: "of:declared",
      path: ["nested"],
    };
    const actualWrite: IMemorySpaceAddress = {
      space,
      id: "of:actual",
      path: ["value"],
    };
    const trace: ActionRunTraceEntry[] = [];
    const log: ReactivityLog = {
      reads: [],
      shallowReads: [],
      writes: [actualWrite],
    };

    for (let recordedAt = 1; recordedAt <= 3; recordedAt++) {
      appendActionRunTrace({
        actionRunTrace: trace,
        nodes,
        getActionId: (candidate) => candidate.name,
        getSchedulingWrites: () => [declaredWrite],
      }, {
        action,
        actionId: action.name,
        durationMs: recordedAt,
        recordedAt,
        maxHistory: 2,
        log,
      });
    }

    expect(trace.map((entry) => entry.recordedAt)).toEqual([2, 3]);
    expect(trace.at(-1)).toMatchObject({
      actionId: action.name,
      actionType: "effect",
      parentActionId: parent.name,
      declaredWrites: [{ space, entityId: "of:declared", path: ["nested"] }],
      actualWrites: [{ space, entityId: "of:actual", path: ["value"] }],
    });
  });
});
