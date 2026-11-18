import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { NodeRegistry } from "../../src/scheduler/node-record.ts";
import type { Action } from "../../src/scheduler/types.ts";
import {
  assessPullWork,
  type PullSchedulingState,
  seedScanNodes,
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

/**
 * Pull-scheduling state over computations whose liveness is whatever `live`
 * holds and whose run requests are whatever `pending` holds, with `asked`
 * counting how often each node's liveness was read.
 */
function computationState(nodes: NodeRegistry) {
  const live = new Set<Action>();
  const pending = new Set<Action>();
  const asked = new Map<Action, number>();
  const effects = new Set<Action>();
  const pullRunnable = {
    effects,
    isDemandedPullComputation: (action: Action) => live.has(action),
    shouldRunFirstPullComputationInDemandContext: () => false,
    isThrottled: () => false,
    isDebouncedComputationWaiting: () => false,
  };
  const state = {
    nodes,
    pending,
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
    isLiveAction: (action: Action) => {
      asked.set(action, (asked.get(action) ?? 0) + 1);
      return live.has(action);
    },
    hasActiveDebounceTimer: () => false,
    getNextEligibleRunTime: () => undefined,
    isConvergenceHoldActive: () => false,
    isConvergenceBackoffDeferred: () => false,
  } satisfies PullSchedulingState;
  return { state, live, pending, asked };
}

/** Registers one never-ran computation per name, in order. */
function computations(nodes: NodeRegistry, ...names: string[]): Action[] {
  return names.map((name) => {
    const action: Action = { [name]: () => {} }[name];
    nodes.register(action, "computation");
    return action;
  });
}

const namesOf = (records: readonly { action: Action }[]): string[] =>
  records.map((record) => record.action.name);

describe("work-oracle", () => {
  describe("seedScanNodes()", () => {
    it("returns the live invalid nodes in the order they became invalid", () => {
      const nodes = new NodeRegistry();
      const [a, _b, c] = computations(nodes, "a", "b", "c");
      const { state, live } = computationState(nodes);
      live.add(c).add(a);

      expect(namesOf(seedScanNodes(state))).toEqual(["a", "c"]);
    });

    it("reads a dormant node's liveness once, however many scans follow", () => {
      const nodes = new NodeRegistry();
      const [a, b] = computations(nodes, "a", "b");
      const { state, live, asked } = computationState(nodes);
      live.add(a);

      // Unverified: the check reads every invalid node's liveness itself.
      seedScanNodes(state, false);
      seedScanNodes(state, false);
      seedScanNodes(state, false);

      expect(asked.get(b)).toBe(1);
      expect(asked.get(a)).toBe(3);
    });

    it("returns a parked node, in its place, once it is reported as possibly live", () => {
      const nodes = new NodeRegistry();
      const [a, b, c] = computations(nodes, "a", "b", "c");
      const { state, live } = computationState(nodes);
      live.add(a).add(c);
      expect(namesOf(seedScanNodes(state))).toEqual(["a", "c"]);

      live.add(b);
      nodes.noteMayBeLive(b);

      expect(namesOf(seedScanNodes(state))).toEqual(["a", "b", "c"]);
    });

    it("parks again a node reported as possibly live that is not", () => {
      const nodes = new NodeRegistry();
      const [_a, b] = computations(nodes, "a", "b");
      const { state, asked } = computationState(nodes);
      seedScanNodes(state, false);

      nodes.noteMayBeLive(b);
      seedScanNodes(state, false);
      seedScanNodes(state, false);

      expect(asked.get(b)).toBe(2);
    });

    it("returns a parked node that has since become pending, with no report", () => {
      const nodes = new NodeRegistry();
      const [a, b, c] = computations(nodes, "a", "b", "c");
      const { state, live, pending } = computationState(nodes);
      live.add(a).add(c);
      seedScanNodes(state);

      pending.add(b);

      expect(namesOf(seedScanNodes(state))).toEqual(["a", "b", "c"]);
    });

    it("returns a parked node again after its status is written", () => {
      const nodes = new NodeRegistry();
      const [a, b] = computations(nodes, "a", "b");
      const { state, live } = computationState(nodes);
      live.add(a);
      seedScanNodes(state);

      live.add(b);
      nodes.setStatus(b, "invalid");

      expect(namesOf(seedScanNodes(state))).toEqual(["a", "b"]);
    });

    it("places a node that became invalid again after the nodes that stayed invalid", () => {
      const nodes = new NodeRegistry();
      const [a, b] = computations(nodes, "a", "b");
      const { state, live } = computationState(nodes);
      live.add(a).add(b);

      nodes.setStatus(a, "clean");
      nodes.setStatus(a, "invalid");

      expect(namesOf(seedScanNodes(state))).toEqual(
        [...nodes.getInvalidNodes()].map((action) => action.name),
      );
      expect(namesOf(seedScanNodes(state))).toEqual(["b", "a"]);
    });

    it("leaves out a node that is no longer invalid", () => {
      const nodes = new NodeRegistry();
      const [a, b] = computations(nodes, "a", "b");
      const { state, live } = computationState(nodes);
      live.add(a).add(b);

      nodes.setStatus(a, "clean");

      expect(namesOf(seedScanNodes(state))).toEqual(["b"]);
    });

    it("throws, when verifying, for a parked node that became live unreported", () => {
      const nodes = new NodeRegistry();
      const [a, b] = computations(nodes, "a", "b");
      const { state, live } = computationState(nodes);
      live.add(a);
      seedScanNodes(state);

      live.add(b);

      expect(() => seedScanNodes(state, true)).toThrow(
        "seed scan drift: missed [b]",
      );
    });

    it("returns what a walk over every invalid node returns, through random changes", () => {
      // The reference: every invalid node that is live or pending, in the
      // registry's order.
      let nonEmpty = 0;
      const stepsTaken = new Map<string, number>();
      for (let seed = 1; seed <= 20; seed++) {
        let value = seed * 2654435761 >>> 0;
        const random = () => {
          value ^= value << 13;
          value ^= value >>> 17;
          value ^= value << 5;
          value >>>= 0;
          return value / 0x100000000;
        };
        const nodes = new NodeRegistry();
        const actions = computations(
          nodes,
          ...Array.from({ length: 12 }, (_, i) => `node${i}`),
        );
        const { state, live, pending } = computationState(nodes);
        const pick = () => actions[Math.floor(random() * actions.length)];
        const took = (kind: string) =>
          stepsTaken.set(kind, (stepsTaken.get(kind) ?? 0) + 1);

        for (let step = 0; step < 300; step++) {
          const roll = random();
          const action = pick();
          if (roll < 0.25) {
            took("came alive");
            live.add(action);
            nodes.noteMayBeLive(action);
          } else if (roll < 0.45) {
            took("went dormant");
            live.delete(action);
          } else if (roll < 0.6) {
            took("requested");
            pending.add(action);
          } else if (roll < 0.7) {
            took("request dropped");
            pending.delete(action);
          } else if (roll < 0.8) {
            took("ran");
            nodes.setStatus(action, "clean");
          } else if (roll < 0.9) {
            took("invalidated");
            nodes.setStatus(action, "invalid");
          } else if (roll < 0.95) {
            took("removed");
            nodes.remove(action);
          } else {
            took("registered");
            nodes.register(action, "computation");
          }
          const expected = [...nodes.getInvalidNodes()].filter((candidate) =>
            live.has(candidate) || pending.has(candidate)
          ).map((candidate) => candidate.name);
          if (expected.length > 0) nonEmpty++;
          expect(namesOf(seedScanNodes(state)), `seed ${seed} step ${step}`)
            .toEqual(expected);
        }
      }
      // Two empty lists compare equal, so say what the run exercised.
      expect(nonEmpty).toBeGreaterThan(3000);
      expect([...stepsTaken.keys()].sort()).toEqual([
        "came alive",
        "invalidated",
        "ran",
        "registered",
        "removed",
        "request dropped",
        "requested",
        "went dormant",
      ]);
    });
  });

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
