import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { PASS_RUN_BUDGET } from "../src/scheduler/constants.ts";
import {
  collectInvalidUpstreamForLog,
  type EventPreflightDependencyState,
} from "../src/scheduler/event-preflight-dependencies.ts";
import type { SchedulerSettleLoopState } from "../src/scheduler/execution.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import { SchedulerMaterializers } from "../src/scheduler/materializers.ts";
import { NodeRegistry } from "../src/scheduler/node-record.ts";
import { runPullSchedulerSettleLoop } from "../src/scheduler/settle.ts";
import type { Action } from "../src/scheduler/types.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
// Identity entity keys resolve scoped addresses against (stage E); these
// tests use space-scoped addresses, so any one identity partitions alike.
const TEST_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};
const identityThunk = () => TEST_IDENTITY;

describe("event preflight convergence demand", () => {
  it("finds an invalid materializer through a transitive reader closure", () => {
    const nodes = new NodeRegistry();
    const materializer: Action = function invalidMaterializer() {};
    const bridge: Action = function materializerBridge() {};
    const closureWriter: Action = function handlerClosureWriter() {};
    const unloggedReader: Action = function unloggedMaterializerReader() {};
    const nonOverlappingReader: Action = function nonOverlappingReader() {};
    nodes.register(materializer, "computation");
    nodes.register(bridge, "computation");
    nodes.register(closureWriter, "computation");
    nodes.register(nonOverlappingReader, "computation");
    nodes.setStatus(materializer, "invalid");
    nodes.setStatus(bridge, "clean");
    nodes.setStatus(closureWriter, "clean");
    nodes.setStatus(nonOverlappingReader, "clean");

    const materialized: IMemorySpaceAddress = {
      space: "did:key:event-materializer-preflight",
      scope: "space",
      id: "of:materialized",
      path: ["value"],
    };
    const handlerInput: IMemorySpaceAddress = {
      space: materialized.space,
      scope: "space",
      id: "of:handler-input",
      path: ["value"],
    };
    const nonOverlappingRead: IMemorySpaceAddress = {
      ...materialized,
      path: ["other"],
    };

    const dependencies = new WeakMap([
      [bridge, { reads: [materialized], shallowReads: [], writes: [] }],
      [
        nonOverlappingReader,
        { reads: [nonOverlappingRead], shallowReads: [], writes: [] },
      ],
    ]);
    const dependents = new WeakMap<Action, Set<Action>>([
      [bridge, new Set([closureWriter])],
    ]);
    const writes = new WeakMap<Action, IMemorySpaceAddress[]>([
      [closureWriter, [handlerInput]],
    ]);
    const materializerIndex = new SchedulerMaterializers(
      nodes.effects,
      identityThunk,
    );
    materializerIndex.registerAddresses(materializer, [materialized]);
    const candidates = new Set([
      materializer,
      unloggedReader,
      nonOverlappingReader,
      bridge,
    ]);
    const state = {
      scopeKeyIdentity: identityThunk,
      getTrace: () => undefined,
      nodes,
      pending: new Set<Action>(),
      reverseDependencies: new WeakMap<Action, Set<Action>>(),
      dependents,
      dependencies,
      writersByEntity: new Map([
        [entityKey(handlerInput, TEST_IDENTITY), new Set([closureWriter])],
      ]),
      effects: nodes.effects,
      materializerIndex,
      triggerIndex: {
        collectReadersForWrite: (write: IMemorySpaceAddress) =>
          entityKey(write, TEST_IDENTITY) ===
              entityKey(materialized, TEST_IDENTITY)
            ? candidates
            : new Set<Action>(),
      },
      getSchedulingWrites: (action: Action) => writes.get(action),
      getActionId: (action: Action) => action.name,
    } satisfies EventPreflightDependencyState;
    const demand = new Set<Action>();

    const found = collectInvalidUpstreamForLog(
      state,
      { reads: [handlerInput], shallowReads: [], writes: [] },
      demand,
    );

    expect(found).toBe(true);
    expect([...demand]).toEqual([materializer]);

    // A trigger-index candidate without a dependency log must not become a
    // materializer reader. Give it an otherwise-valid path to the closure so
    // an erroneous admission would turn this into a false positive.
    candidates.clear();
    candidates.add(unloggedReader);
    dependents.set(unloggedReader, new Set([closureWriter]));
    const unloggedDemand = new Set<Action>();
    expect(
      collectInvalidUpstreamForLog(
        state,
        { reads: [handlerInput], shallowReads: [], writes: [] },
        unloggedDemand,
      ),
    ).toBe(false);
    expect([...unloggedDemand]).toEqual([]);

    // Likewise, a logged reader of a disjoint path must not create the
    // materializer edge even when it could otherwise reach the closure.
    candidates.clear();
    candidates.add(nonOverlappingReader);
    dependents.set(nonOverlappingReader, new Set([closureWriter]));
    const nonOverlappingDemand = new Set<Action>();
    expect(
      collectInvalidUpstreamForLog(
        state,
        { reads: [handlerInput], shallowReads: [], writes: [] },
        nonOverlappingDemand,
      ),
    ).toBe(false);
    expect([...nonOverlappingDemand]).toEqual([]);
  });

  it("skips a time-gated action until its next eligible iteration", async () => {
    const nodes = new NodeRegistry();
    const action: Action = function timeGatedAction() {};
    nodes.register(action, "computation");
    nodes.setStatus(action, "invalid");
    const pending = new Set<Action>([action]);
    const dependencies = new WeakMap<Action, {
      reads: IMemorySpaceAddress[];
      shallowReads: IMemorySpaceAddress[];
      writes: IMemorySpaceAddress[];
    }>();
    const schedulingWrites = new WeakMap<Action, IMemorySpaceAddress[]>();
    const filterStats = { filtered: 0, executed: 0 };
    const futureEligibility = performance.now() + 60_000;
    let eligibilityReads = 0;
    let runs = 0;
    const materializerIndex = {
      scopeKeyIdentity: identityThunk,
      materializersByEntity: new Map(),
      effects: nodes.effects,
      getMaterializerWriteEnvelopes: () => undefined,
      isMaterializer: () => false,
    };
    const state = {
      scopeKeyIdentity: identityThunk,
      getCollectSettleStats: () => false,
      effects: nodes.effects,
      computations: nodes.computations,
      pending,
      dependencies,
      nodes,
      dependents: new WeakMap<Action, Set<Action>>(),
      filterStats,
      materializerIndex,
      writersByEntity: new Map(),
      getSchedulingWrites: (candidate: Action) =>
        schedulingWrites.get(candidate),
      getSchedulingWritesMap: () => schedulingWrites,
      collectPullIterationSeeds: () => {},
      getActionId: (candidate: Action) => candidate.name,
      isThrottled: () => false,
      getNextEligibleRunTime: () =>
        eligibilityReads++ === 0 ? futureEligibility : undefined,
      isDebouncedComputationWaiting: () => false,
      clearComputationDebounceState: () => {},
      isLiveAction: () => true,
      runAction: () => {
        runs++;
        nodes.setStatus(action, "clean");
        return Promise.resolve();
      },
    } satisfies SchedulerSettleLoopState;

    const result = await runPullSchedulerSettleLoop(state, new Set([action]));

    expect(filterStats).toEqual({ filtered: 1, executed: 1 });
    expect(pending.size).toBe(0);
    expect(runs).toBe(1);
    expect(result.iterationsRun).toBe(2);
    expect(result.settledEarly).toBe(true);
  });

  it("keeps an alternating event-only cycle under one pass's budgets", async () => {
    const nodes = new NodeRegistry();
    const actionA: Action = function eventOnlyCycleA() {};
    const actionB: Action = function eventOnlyCycleB() {};
    const recordA = nodes.register(actionA, "computation");
    const recordB = nodes.register(actionB, "computation");
    nodes.setStatus(actionA, "invalid");
    nodes.setStatus(actionB, "clean");
    const pending = new Set<Action>([actionA]);
    let runs = 0;
    const outputA: IMemorySpaceAddress = {
      space: "did:key:event-convergence",
      id: "event:cycle-a",
      path: [],
    };
    const outputB: IMemorySpaceAddress = {
      space: "did:key:event-convergence",
      id: "event:cycle-b",
      path: [],
    };
    const dependencies = new WeakMap([
      [actionA, { reads: [outputB], shallowReads: [], writes: [outputA] }],
      [actionB, { reads: [outputA], shallowReads: [], writes: [outputB] }],
    ]);
    const dependents = new WeakMap<Action, Set<Action>>([
      [actionA, new Set([actionB])],
      [actionB, new Set([actionA])],
    ]);
    const reverseDependencies = new WeakMap<Action, Set<Action>>([
      [actionA, new Set([actionB])],
      [actionB, new Set([actionA])],
    ]);
    const writes = new WeakMap<Action, IMemorySpaceAddress[]>([
      [actionA, [outputA]],
      [actionB, [outputB]],
    ]);
    const writersByEntity = new Map([
      [entityKey(outputA, TEST_IDENTITY), new Set([actionA])],
      [entityKey(outputB, TEST_IDENTITY), new Set([actionB])],
    ]);
    const materializerIndex = {
      scopeKeyIdentity: identityThunk,
      materializersByEntity: new Map(),
      effects: nodes.effects,
      getMaterializerWriteEnvelopes: () => undefined,
      isMaterializer: () => false,
    };
    const preflightState = {
      scopeKeyIdentity: identityThunk,
      getTrace: () => undefined,
      nodes,
      pending,
      reverseDependencies,
      dependents,
      dependencies,
      writersByEntity,
      effects: nodes.effects,
      materializerIndex,
      triggerIndex: { collectReadersForWrite: () => new Set<Action>() },
      getSchedulingWrites: (action) => writes.get(action),
      getActionId: (action) =>
        action === actionA ? "event-only-cycle-a" : "event-only-cycle-b",
    } satisfies EventPreflightDependencyState;
    const handlerDeps = {
      reads: [outputB],
      shallowReads: [],
      writes: [],
    };

    const state = {
      scopeKeyIdentity: identityThunk,
      getCollectSettleStats: () => false,
      effects: nodes.effects,
      computations: nodes.computations,
      pending,
      dependencies,
      nodes,
      dependents,
      filterStats: { filtered: 0, executed: 0 },
      materializerIndex,
      writersByEntity,
      getSchedulingWrites: (action) => writes.get(action),
      getSchedulingWritesMap: () => writes,
      collectPullIterationSeeds: () => {},
      refreshPassScopedDemand: (demand) => {
        // This is the production refresh shape: rerun decision 15's inverted
        // invalid-node -> handler-closure query on every settle iteration.
        demand.clear();
        collectInvalidUpstreamForLog(preflightState, handlerDeps, demand);
      },
      getActionId: (action) =>
        action === actionA ? "event-only-cycle-a" : "event-only-cycle-b",
      isThrottled: () => false,
      getNextEligibleRunTime: () => undefined,
      isDebouncedComputationWaiting: () => false,
      clearComputationDebounceState: () => {},
      // The action is demanded only by the head event's preflight closure.
      isLiveAction: () => false,
      runAction: (action) => {
        runs++;
        // Each successful run invalidates the other, initially-clean member.
        // A is the only node invalid at preflight; B must become transiently
        // demanded when the next settle iteration re-evaluates the closure.
        nodes.setStatus(action, "clean");
        nodes.setStatus(action === actionA ? actionB : actionA, "invalid");
        return Promise.resolve();
      },
    } satisfies SchedulerSettleLoopState;

    const result = await runPullSchedulerSettleLoop(
      state,
      new Set([actionA]),
    );

    expect(runs).toBe(PASS_RUN_BUDGET);
    expect(pending.size).toBe(0);
    expect(result.settledEarly).toBe(false);
    expect(result.backoffApplied).toBe(true);
    expect(result.backoffActionCount).toBe(1);
    const deferred = [recordA, recordB].filter((record) =>
      record.gate.backoffUntil !== undefined
    );
    expect(deferred.length).toBe(1);
    expect(deferred[0].gate.backoffUntil).toBeGreaterThan(performance.now());
    expect(deferred[0].gate.convergenceHoldPasses).toBe(1);
  });
});
