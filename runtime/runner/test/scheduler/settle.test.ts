import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { PASS_RUN_BUDGET } from "../../src/scheduler/constants.ts";
import type { SchedulerSettleLoopState } from "../../src/scheduler/execution.ts";
import { NodeRegistry } from "../../src/scheduler/node-record.ts";
import { runPullSchedulerSettleLoop } from "../../src/scheduler/settle.ts";
import type { Action } from "../../src/scheduler/types.ts";
import type { IMemorySpaceAddress } from "../../src/storage/interface.ts";
import { captureLogs, type LogCapture } from "../support/log-capture.ts";

const identity = { principal: "did:test:settle", sessionId: "session-1" };

/**
 * Settle-loop state over one invalid, live computation, `action`, whose run
 * leaves it as `runAction` says, with every gate open unless `gates` closes
 * one.
 */
function settleState(
  nodes: NodeRegistry,
  action: Action,
  runAction: () => void,
  gates: Partial<
    Pick<
      SchedulerSettleLoopState,
      | "isThrottled"
      | "getNextEligibleRunTime"
      | "isDebouncedComputationWaiting"
    >
  > = {},
) {
  return {
    scopeKeyIdentity: () => identity,
    getCollectSettleStats: () => false,
    effects: nodes.effects,
    computations: nodes.computations,
    pending: new Set<Action>([action]),
    dependencies: new WeakMap(),
    nodes,
    dependents: new WeakMap<Action, Set<Action>>(),
    filterStats: { filtered: 0, executed: 0 },
    materializerIndex: {
      scopeKeyIdentity: () => identity,
      materializersByEntity: new Map(),
      effects: nodes.effects,
      getMaterializerWriteEnvelopes: () => undefined,
      isMaterializer: () => false,
    },
    writersByEntity: new Map(),
    getSchedulingWrites: () => undefined,
    getSchedulingWritesMap: () => new WeakMap<Action, IMemorySpaceAddress[]>(),
    collectPullIterationSeeds: () => {},
    getActionId: (candidate: Action) => candidate.name,
    isThrottled: gates.isThrottled ?? (() => false),
    getNextEligibleRunTime: gates.getNextEligibleRunTime ?? (() => undefined),
    isDebouncedComputationWaiting: gates.isDebouncedComputationWaiting ??
      (() => false),
    clearComputationDebounceState: () => {},
    isLiveAction: () => true,
    runAction: () => {
      runAction();
      return Promise.resolve();
    },
  } satisfies SchedulerSettleLoopState;
}

/** A gate that holds the action back the first time it is asked, only. */
function closedOnce(): () => boolean {
  let asked = 0;
  return () => asked++ === 0;
}

describe("settle", () => {
  describe("runPullSchedulerSettleLoop()", () => {
    // The skip and backoff paths report at debug level, so each case reads
    // the scheduler's debug output as well as what the loop did.

    let debug: LogCapture;

    beforeEach(() => {
      debug = captureLogs("scheduler");
    });

    afterEach(() => {
      debug[Symbol.dispose]();
    });

    describe("an action a gate holds back", () => {
      it("skips a computation whose debounce is waiting, and runs it once the debounce lets it", async () => {
        const nodes = new NodeRegistry();
        const action: Action = function debounced() {};
        nodes.register(action, "computation");
        let runs = 0;
        const state = settleState(nodes, action, () => {
          runs++;
          nodes.setStatus(action, "clean");
        }, { isDebouncedComputationWaiting: closedOnce() });

        const result = await runPullSchedulerSettleLoop(
          state,
          new Set([action]),
        );

        expect(state.filterStats).toEqual({ filtered: 1, executed: 1 });
        expect(runs).toBe(1);
        expect(result.settledEarly).toBe(true);
        expect(debug.lines("schedule-debounce")).toContainEqual(
          expect.stringContaining(
            "[DEBOUNCE] Skipping debounced computation: debounced",
          ),
        );
      });

      it("skips a throttled action, and runs it once the throttle lets it", async () => {
        const nodes = new NodeRegistry();
        const action: Action = function throttled() {};
        nodes.register(action, "computation");
        let runs = 0;
        const state = settleState(nodes, action, () => {
          runs++;
          nodes.setStatus(action, "clean");
        }, { isThrottled: closedOnce() });

        const result = await runPullSchedulerSettleLoop(
          state,
          new Set([action]),
        );

        expect(state.filterStats).toEqual({ filtered: 1, executed: 1 });
        expect(runs).toBe(1);
        expect(result.settledEarly).toBe(true);
        expect(debug.lines("schedule-throttle")).toContainEqual(
          expect.stringContaining(
            "[THROTTLE] Skipping throttled action: throttled",
          ),
        );
      });

      it("skips a time-gated action, and runs it once the gate lets it", async () => {
        const nodes = new NodeRegistry();
        const action: Action = function timeGated() {};
        nodes.register(action, "computation");
        let runs = 0;
        const gated = closedOnce();
        const state = settleState(nodes, action, () => {
          runs++;
          nodes.setStatus(action, "clean");
        }, {
          getNextEligibleRunTime: () =>
            gated() ? performance.now() + 60_000 : undefined,
        });

        await runPullSchedulerSettleLoop(state, new Set([action]));

        expect(state.filterStats).toEqual({ filtered: 1, executed: 1 });
        expect(runs).toBe(1);
        expect(debug.lines("schedule-backoff")).toContainEqual(
          expect.stringContaining(
            "[GATE] Skipping time-gated action: timeGated",
          ),
        );
      });
    });

    it("backs off an action that spends its pass budget without settling", async () => {
      const nodes = new NodeRegistry();
      const action: Action = function unsettled() {};
      nodes.register(action, "computation");
      let runs = 0;
      const state = settleState(nodes, action, () => {
        runs++;
        nodes.setStatus(action, "invalid");
      });

      const result = await runPullSchedulerSettleLoop(state, new Set([action]));

      expect(runs).toBe(PASS_RUN_BUDGET);
      expect(result.backoffApplied).toBe(true);
      expect(result.backoffActions).toEqual([action]);
      expect(result.backoffUntil).toBe(nodes.get(action)?.gate.backoffUntil);
      expect(debug.lines("schedule-backoff")).toContainEqual(
        expect.stringMatching(
          /\[BACKOFF\] pass-budget: deferred 1 action\(s\) wake in \d+ms/,
        ),
      );
    });
  });
});
