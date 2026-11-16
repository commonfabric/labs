import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { NodeRegistry } from "../../src/scheduler/node-record.ts";
import type { Action } from "../../src/scheduler/types.ts";
import {
  assessPullWork,
  type PullSchedulingState,
} from "../../src/scheduler/work-oracle.ts";

/** Pull-scheduling state whose `pending` holds one effect, `effect`, and
 * whose gates hold nothing back. */
function pendingEffectState(nodes: NodeRegistry, effect: Action) {
  const effects = new Set([effect]);
  const pullRunnable = {
    effects,
    isDemandedPullComputation: () => false,
    shouldRunFirstPullComputationInDemandContext: () => false,
    isThrottled: () => false,
    isDebouncedComputationWaiting: () => false,
  };
  return {
    nodes,
    pending: new Set([effect]),
    effects,
    materializerIndex: {
      scopeKeyIdentity: () => ({ principal: "did:test:oracle" }),
      materializersByEntity: new Map(),
      effects,
      getMaterializerWriteEnvelopes: () => undefined,
      isMaterializer: () => false,
    },
    pendingPullRunnableState: pullRunnable,
    dirtyPullRunnableState: pullRunnable,
    dirtyPullRunnableStateWithDebounce: pullRunnable,
    isLiveAction: () => true,
    hasActiveDebounceTimer: () => false,
    getNextEligibleRunTime: () => undefined,
    isConvergenceHoldActive: () => false,
    isConvergenceBackoffDeferred: () => false,
  } satisfies PullSchedulingState;
}

describe("work-oracle", () => {
  describe("assessPullWork()", () => {
    it("returns runnable work for a pending effect that is registered", () => {
      const nodes = new NodeRegistry();
      const effect: Action = function effect() {};
      nodes.register(effect, "effect");

      expect(assessPullWork(pendingEffectState(nodes, effect))).toEqual({
        runnableNow: true,
        deferredIdleBlocking: false,
      });
    });

    it("returns no work for a pending effect that was never registered", () => {
      const nodes = new NodeRegistry();
      const effect: Action = function effect() {};

      expect(assessPullWork(pendingEffectState(nodes, effect))).toEqual({
        runnableNow: false,
        deferredIdleBlocking: false,
      });
    });
  });
});
