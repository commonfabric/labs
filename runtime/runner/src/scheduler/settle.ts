import { getLogger } from "@commonfabric/utils/logger";
import { topologicalSort } from "./topology.ts";
import type { Action, SettleIterationStats } from "./types.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import { collectMaterializerWritersForLog } from "./materializers.ts";
import { forEachOverlappingWriter } from "./scheduling-writes.ts";
import {
  planBudgetBackoff,
  recordSettleActionRun,
  type SchedulerSettleLoopState,
  type SchedulerSettleResult,
  summarizeSettleIteration,
  summarizeSettleRun,
} from "./execution.ts";
import { MAX_ITERS, PASS_RUN_BUDGET } from "./constants.ts";
import {
  isIdleMaterializerRunnable,
  isInvalidOrNeverRan,
  isPendingPullActionRunnable,
  isRunnableSchedulingSeed,
  type PullSchedulingState,
} from "./work-oracle.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

export function collectPullIterationSeeds(
  state: PullSchedulingState,
  workSet: Set<Action>,
): void {
  const initialSize = workSet.size;
  collectPrimaryPullIterationSeeds(state, workSet);

  if (workSet.size > initialSize || initialSize > 0) {
    return;
  }

  collectIdleMaterializerSeeds(state, workSet);
}

function collectPrimaryPullIterationSeeds(
  state: PullSchedulingState,
  workSet: Set<Action>,
): void {
  for (const action of state.pending) {
    if (state.materializerIndex.isMaterializer(action)) continue;
    const record = state.nodes.get(action);
    if (
      record &&
      isRunnableSchedulingSeed(state, record) &&
      isPendingPullActionRunnable(state.pendingPullRunnableState, action)
    ) {
      workSet.add(action);
    }
  }

  // Every runnable seed is invalid/never-ran (isRunnableSchedulingSeed gates
  // on isInvalidOrNeverRan), so the invalid-node index is exactly the
  // candidate set — iterate it instead of every registered node.
  for (const action of state.nodes.getInvalidNodes()) {
    if (state.materializerIndex.isMaterializer(action)) continue;
    const record = state.nodes.get(action);
    if (record && isRunnableSchedulingSeed(state, record)) {
      workSet.add(action);
    }
  }
}

function collectIdleMaterializerSeeds(
  state: PullSchedulingState,
  workSet: Set<Action>,
): void {
  for (const action of state.pending) {
    const record = state.nodes.get(action);
    if (record && isIdleMaterializerRunnable(state, record)) {
      workSet.add(action);
    }
  }

  for (const action of state.nodes.getInvalidNodes()) {
    const record = state.nodes.get(action);
    if (!record) continue;
    if (isIdleMaterializerRunnable(state, record)) {
      workSet.add(record.action);
    }
  }
}

type PullSettleIteration = { settled: true } | {
  settled: false;
  workSet: Set<Action>;
  order: Action[];
  declaredReadPulledActions: Set<Action>;
};

function buildPullIterationWorkSet(state: {
  readonly initialSeeds: ReadonlySet<Action>;
  readonly scopeKeyIdentity: SchedulerSettleLoopState["scopeKeyIdentity"];
  readonly nodes: SchedulerSettleLoopState["nodes"];
  readonly dependencies: SchedulerSettleLoopState["dependencies"];
  readonly materializerIndex: SchedulerSettleLoopState["materializerIndex"];
  readonly writersByEntity: SchedulerSettleLoopState["writersByEntity"];
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly getSchedulingWrites: (
    action: Action,
  ) => readonly IMemorySpaceAddress[] | undefined;
  readonly isLiveAction: (action: Action) => boolean;
  readonly collectPullIterationSeeds: (iterationSeeds: Set<Action>) => void;
}): {
  workSet: Set<Action>;
  iterationSeeds: Set<Action>;
  materializerPromotionCount: number;
  declaredReadPulledActions: Set<Action>;
} {
  const workSet = new Set<Action>();
  const iterationSeeds = new Set<Action>();
  const declaredReadPulledActions = new Set<Action>();

  for (const seed of state.initialSeeds) {
    const record = state.nodes.get(seed);
    // Event-preflight seeds are transient demand roots for the whole pass. A
    // clean seed contributes no work, but if another node re-invalidates it in
    // a later iteration it must re-enter the work set so convergence budgets
    // and backoff apply exactly as they do for standing demand roots.
    if (record && isInvalidOrNeverRan(record)) {
      iterationSeeds.add(seed);
    }
  }

  // Every iteration needs to consider newly created pending effects.
  // Without this, nested/recursive patterns can stall after creating
  // new demand-root effects in an earlier iteration.
  state.collectPullIterationSeeds(iterationSeeds);

  for (const seed of iterationSeeds) {
    workSet.add(seed);
  }

  const beforePromotions = workSet.size;
  addInvalidMaterializerPromotions(state, iterationSeeds, workSet);
  const materializerPromotionCount = workSet.size - beforePromotions;
  addDeclaredReadWriterClosure(state, workSet, declaredReadPulledActions);
  addLiveDownstreamClosure(state, workSet);
  addDeclaredReadWriterClosure(state, workSet, declaredReadPulledActions);

  return {
    workSet,
    iterationSeeds,
    materializerPromotionCount,
    declaredReadPulledActions,
  };
}

function addDeclaredReadWriterClosure(
  state: {
    readonly scopeKeyIdentity: SchedulerSettleLoopState["scopeKeyIdentity"];
    readonly nodes: SchedulerSettleLoopState["nodes"];
    readonly materializerIndex: SchedulerSettleLoopState["materializerIndex"];
    readonly writersByEntity: SchedulerSettleLoopState["writersByEntity"];
    readonly getSchedulingWrites: (
      action: Action,
    ) => readonly IMemorySpaceAddress[] | undefined;
  },
  workSet: Set<Action>,
  declaredReadPulledActions: Set<Action>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const readerAction of [...workSet]) {
      const reader = state.nodes.get(readerAction);
      if (
        reader?.status !== "never-ran" ||
        reader.declaredReads.length === 0
      ) {
        continue;
      }

      const consider = (writerAction: Action): void => {
        if (writerAction === readerAction || workSet.has(writerAction)) {
          return;
        }
        const writer = state.nodes.get(writerAction);
        if (!writer || !isInvalidOrNeverRan(writer)) return;
        workSet.add(writerAction);
        declaredReadPulledActions.add(writerAction);
        changed = true;
      };

      // Static write surfaces via the writer index (previously an
      // O(workSet x allNodes) full-registry fixpoint scan).
      forEachOverlappingWriter(
        {
          scopeKeyIdentity: state.scopeKeyIdentity,
          writersByEntity: state.writersByEntity,
          getSchedulingWrites: state.getSchedulingWrites,
        },
        reader.declaredReads,
        [],
        (writer) => consider(writer),
      );
      // Materializer write envelopes reach declared readers the same way.
      for (
        const writerAction of collectMaterializerWritersForLog(
          state.materializerIndex,
          { reads: reader.declaredReads, shallowReads: [], writes: [] },
          { exclude: readerAction },
        )
      ) {
        consider(writerAction);
      }
    }
  }
}
function addInvalidMaterializerPromotions(
  state: {
    readonly nodes: SchedulerSettleLoopState["nodes"];
    readonly dependencies: SchedulerSettleLoopState["dependencies"];
    readonly materializerIndex: SchedulerSettleLoopState["materializerIndex"];
  },
  seeds: ReadonlySet<Action>,
  workSet: Set<Action>,
): void {
  for (const seed of seeds) {
    const log = state.dependencies.get(seed);
    if (!log) continue;

    for (
      const materializer of collectMaterializerWritersForLog(
        state.materializerIndex,
        log,
        { exclude: seed },
      )
    ) {
      const record = state.nodes.get(materializer);
      if (record && isInvalidOrNeverRan(record)) {
        workSet.add(materializer);
      }
    }
  }
}

function addLiveDownstreamClosure(state: {
  readonly nodes: SchedulerSettleLoopState["nodes"];
  readonly dependents: WeakMap<Action, Set<Action>>;
  readonly isLiveAction: (action: Action) => boolean;
}, workSet: Set<Action>): void {
  const visited = new Set<Action>();
  const dirtyRoots = [...workSet].filter((action) => {
    const record = state.nodes.get(action);
    return record !== undefined && isInvalidOrNeverRan(record);
  });

  const visit = (action: Action): void => {
    if (visited.has(action)) return;
    visited.add(action);

    const dependents = state.dependents.get(action);
    if (!dependents) return;

    for (const dependent of dependents) {
      if (!state.isLiveAction(dependent)) continue;
      workSet.add(dependent);
      // Solution #1 (walk-computed invalid-upstream prune): only descend past a
      // dependent that is ITSELF invalid/never-ran — it will run and propagate
      // this iteration, so its downstream may also become runnable now. A clean
      // live dependent is still added (tier-1 speculation, needed e.g. for
      // materializer-output readers — see "should schedule normal output
      // readers when a materializer input dirties"), but its own downstream
      // cannot become runnable until it actually runs, so we do NOT
      // speculatively pull the clean TAIL of the cone. When this node runs and
      // changes, channel-1 invalidates its dependents and the settle loop
      // re-seeds them next iteration. Bounds the per-pass work-set under
      // wide-fan-out hubs (the closure 3b's deleted staleness pruning kept
      // small) with no change to executions or settle-iteration count.
      const dependentRecord = state.nodes.get(dependent);
      if (
        dependentRecord !== undefined && isInvalidOrNeverRan(dependentRecord)
      ) {
        visit(dependent);
      }
    }
  };

  for (const action of dirtyRoots) {
    visit(action);
  }
}

export async function runPullSchedulerSettleLoop(
  state: SchedulerSettleLoopState,
  initialSeeds: ReadonlySet<Action>,
): Promise<SchedulerSettleResult> {
  // Pull mode settles demand roots plus the dirty computations they observe.
  // Event-preflight seeds remain transient roots throughout the pass; every
  // iteration also processes new subscriptions and re-collects dirty deps.
  logger.timeStart("scheduler", "execute", "settle");
  const maxSettleIterations = MAX_ITERS;
  let lastWorkSet: Set<Action> = new Set();
  let settledEarly = false;
  let backoffApplied = false;
  let backoffActionCount = 0;
  const backoffActions = new Set<Action>();
  let backoffUntil: number | undefined;
  const collectSettleStats = state.getCollectSettleStats();
  const passScopedDemand = new Set(initialSeeds);
  const settleIterStats: SettleIterationStats[] | undefined = collectSettleStats
    ? []
    : undefined;
  // Measured unconditionally (unlike the opt-in per-iteration stats): the
  // scheduler.settle telemetry marker needs it on every pass.
  const settleStartTime = performance.now();
  let iterationsRun = 0;

  for (let settleIter = 0; settleIter < maxSettleIterations; settleIter++) {
    const iterStart = settleIterStats ? performance.now() : 0;
    state.refreshPassScopedDemand?.(passScopedDemand);

    const iteration = preparePullSettleIteration(
      state,
      passScopedDemand,
      settleIter,
    );

    if (iteration.settled) {
      settledEarly = true;
      break;
    }
    iterationsRun++;

    lastWorkSet = iteration.workSet;
    const iterationWorkSetSize = iteration.workSet.size;
    const iterActionsRun = await runPullSettleOrder(
      state,
      iteration.order,
      iteration.declaredReadPulledActions,
      passScopedDemand,
    );
    if (didAnyActionHitPassRunBudget(state, iteration.order)) {
      // Gate only the actions that actually exhausted their budget (the
      // candidate filter requires passRuns >= PASS_RUN_BUDGET): a node with
      // zero runs this pass has produced no evidence of non-convergence, and
      // gating it defers first-run frontier work past idle() (the
      // calendar/extractor bystander-backoff regression). Ungated runnable
      // work continues in the next pass via the continuation re-tick.
      const budgetBackoff = maybeApplyBudgetBackoff(
        state,
        collectCurrentBackoffCandidates(state),
        "pass-budget",
        passScopedDemand,
      );
      if (budgetBackoff.applied) {
        backoffApplied = true;
        backoffActionCount += budgetBackoff.actionCount;
        for (const action of budgetBackoff.actions) {
          backoffActions.add(action);
        }
        backoffUntil = minDefined(backoffUntil, budgetBackoff.backoffUntil);
        break;
      }
    }

    if (settleIterStats) {
      settleIterStats.push(summarizeSettleIteration({
        workSetSize: iterationWorkSetSize,
        order: iteration.order,
        actionsRun: iterActionsRun,
        durationMs: performance.now() - iterStart,
        effects: state.effects,
        getActionId: (action) => state.getActionId(action),
      }));
    }
  }

  if (!settledEarly && !backoffApplied && lastWorkSet.size > 0) {
    // The last action may have shifted an event-only cycle's invalid frontier
    // to a different closure member. Refresh once after the final iteration so
    // iteration-cap backoff targets the CURRENT frontier, not the work set that
    // was current before that action ran.
    state.refreshPassScopedDemand?.(passScopedDemand);
    const iterationCapCandidates = new Set([
      ...lastWorkSet,
      ...passScopedDemand,
    ]);
    const iterationBackoff = maybeApplyBudgetBackoff(
      state,
      iterationCapCandidates,
      "iteration-cap",
      passScopedDemand,
    );
    backoffApplied = iterationBackoff.applied;
    backoffActionCount += iterationBackoff.actionCount;
    for (const action of iterationBackoff.actions) {
      backoffActions.add(action);
    }
    backoffUntil = minDefined(backoffUntil, iterationBackoff.backoffUntil);
  }

  const settleStats = settleIterStats
    ? summarizeSettleRun({
      iterations: settleIterStats,
      totalDurationMs: performance.now() - settleStartTime,
      settledEarly,
      initialSeedCount: initialSeeds.size,
    })
    : undefined;

  logger.timeEnd("scheduler", "execute", "settle");

  return {
    settledEarly,
    maxSettleIterations,
    backoffApplied,
    backoffActionCount,
    backoffActions: [...backoffActions],
    iterationsRun,
    settleDurationMs: performance.now() - settleStartTime,
    workSetSize: lastWorkSet.size,
    ...(backoffUntil !== undefined ? { backoffUntil } : {}),
    ...(settleStats ? { settleStats } : {}),
  };
}

function preparePullSettleIteration(
  state: SchedulerSettleLoopState,
  initialSeeds: ReadonlySet<Action>,
  settleIter: number,
): PullSettleIteration {
  const { workSet, declaredReadPulledActions } =
    buildAndLogPullIterationWorkSet(
      state,
      initialSeeds,
      settleIter,
    );

  if (workSet.size === 0) {
    return { settled: true };
  }

  const order = orderPullWorkSet(state, workSet, settleIter);

  return { settled: false, workSet, order, declaredReadPulledActions };
}

function buildAndLogPullIterationWorkSet(
  state: SchedulerSettleLoopState,
  initialSeeds: ReadonlySet<Action>,
  settleIter: number,
): {
  workSet: Set<Action>;
  iterationSeeds: Set<Action>;
  materializerPromotionCount: number;
  declaredReadPulledActions: Set<Action>;
} {
  const buildPullWorkSetStart = performance.now();
  const result = buildPullIterationWorkSet({
    initialSeeds,
    scopeKeyIdentity: state.scopeKeyIdentity,
    nodes: state.nodes,
    dependencies: state.dependencies,
    materializerIndex: state.materializerIndex,
    writersByEntity: state.writersByEntity,
    dependents: state.dependents,
    getSchedulingWrites: state.getSchedulingWrites,
    isLiveAction: state.isLiveAction,
    collectPullIterationSeeds: state.collectPullIterationSeeds,
  });

  if (settleIter === 0) {
    logger.debug("schedule-execute-pull", () => [
      `Pull mode: Seeds: ${result.iterationSeeds.size}, Materializers promoted: ${result.materializerPromotionCount}`,
    ]);
  }
  logger.time(
    buildPullWorkSetStart,
    "scheduler",
    "execute",
    "buildPullWorkSet",
  );

  return result;
}

function orderPullWorkSet(
  state: SchedulerSettleLoopState,
  workSet: Set<Action>,
  settleIter: number,
): Action[] {
  const topologicalSortStart = performance.now();
  const order = topologicalSort(
    workSet,
    state.dependencies,
    state.getSchedulingWritesMap(),
    state.nodes,
    state.dependents,
    (action) => state.materializerIndex.getMaterializerWriteEnvelopes(action),
  );
  logger.time(
    topologicalSortStart,
    "scheduler",
    "execute",
    "topologicalSort",
  );

  logger.debug("schedule-execute", () => [
    `Running ${order.length} actions (settle iteration ${settleIter})`,
  ]);

  return order;
}

async function runPullSettleOrder(
  state: SchedulerSettleLoopState,
  order: readonly Action[],
  declaredReadPulledActions: ReadonlySet<Action>,
  passScopedDemand: ReadonlySet<Action>,
): Promise<number> {
  let actionsRun = 0;
  for (const fn of order) {
    // The serving posture's cooperative macrotask yield (server-execution
    // v2 stage C tuning T3, cooperative-yield.ts): between runs, once the
    // slice is spent, let the wave's flush-deadline timer, the lease
    // renew, and the push flush fire. `yieldBetweenRuns` is installed
    // only on a serving runtime; everywhere else this is one undefined
    // check and the loop keeps its exact microtask shape (no `await`).
    if (state.yieldBetweenRuns !== undefined) {
      const turn = state.yieldBetweenRuns();
      if (turn !== undefined) await turn;
    }
    actionsRun += await runPullSettleAction(
      state,
      fn,
      declaredReadPulledActions.has(fn),
      passScopedDemand.has(fn),
    );
  }
  return actionsRun;
}

async function runPullSettleAction(
  state: SchedulerSettleLoopState,
  fn: Action,
  isDeclaredReadPulled: boolean,
  isPassScopedDemanded: boolean,
): Promise<number> {
  // Check if action is still scheduled (not unsubscribed during this tick).
  // Running an action might unsubscribe other actions in the workSet.
  const isStillScheduled = state.computations.has(fn) || state.effects.has(fn);
  if (!isStillScheduled) return 0;

  if (
    !isPullSettleActionStillRunnable(
      state,
      fn,
      isDeclaredReadPulled,
      isPassScopedDemanded,
    )
  ) {
    return 0;
  }
  if (skipPullDelayedSettleAction(state, fn)) return 0;

  // Clean up explicit scheduling state before running. The node status is
  // set clean inside runSchedulerAction before invoking the action body.
  state.pending.delete(fn);
  if (state.computations.has(fn)) {
    state.clearComputationDebounceState(fn);
  }

  state.filterStats.executed++;
  recordSettleActionRun(state, fn);

  await state.runAction(fn);
  return 1;
}

function maybeApplyBudgetBackoff(
  state: SchedulerSettleLoopState,
  workSet: ReadonlySet<Action>,
  reason: "iteration-cap" | "pass-budget",
  passScopedDemand: ReadonlySet<Action>,
): {
  applied: boolean;
  actionCount: number;
  actions: readonly Action[];
  backoffUntil?: number;
} {
  const plan = planBudgetBackoff({
    workSet,
    nodes: state.nodes,
    pending: state.pending,
    isLiveAction: state.isLiveAction,
    getNextEligibleRunTime: state.getNextEligibleRunTime,
    isDebouncedComputationWaiting: state.isDebouncedComputationWaiting,
    reason,
    passScopedDemand,
  });
  if (plan.actions.length === 0) {
    return { applied: false, actionCount: 0, actions: [] };
  }

  logger.debug("schedule-backoff", () => [
    `[BACKOFF] ${reason}: deferred ${plan.actions.length} action(s)`,
    ...(plan.backoffUntil !== undefined
      ? [
        `wake in ${
          Math.max(0, Math.round(plan.backoffUntil - performance.now()))
        }ms`,
      ]
      : []),
  ]);

  return {
    applied: true,
    actionCount: plan.actions.length,
    actions: plan.actions,
    ...(plan.backoffUntil !== undefined
      ? { backoffUntil: plan.backoffUntil }
      : {}),
  };
}

function didAnyActionHitPassRunBudget(
  state: SchedulerSettleLoopState,
  actions: readonly Action[],
): boolean {
  return actions.some((action) =>
    (state.nodes.get(action)?.passRuns ?? 0) >= PASS_RUN_BUDGET
  );
}

function collectCurrentBackoffCandidates(
  state: SchedulerSettleLoopState,
): Set<Action> {
  const candidates = new Set<Action>();
  for (const record of state.nodes.nodes()) {
    candidates.add(record.action);
  }
  return candidates;
}

function isPullSettleActionStillRunnable(
  state: SchedulerSettleLoopState,
  fn: Action,
  isDeclaredReadPulled: boolean,
  isPassScopedDemanded: boolean,
): boolean {
  const record = state.nodes.get(fn);
  return record !== undefined &&
    isInvalidOrNeverRan(record) &&
    (
      state.isLiveAction(fn) ||
      state.pending.has(fn) ||
      isDeclaredReadPulled ||
      isPassScopedDemanded
    ) &&
    record.passRuns < PASS_RUN_BUDGET;
}

function skipPullDelayedSettleAction(
  state: SchedulerSettleLoopState,
  fn: Action,
): boolean {
  if (state.isDebouncedComputationWaiting(fn)) {
    logger.debug("schedule-debounce", () => [
      `[DEBOUNCE] Skipping debounced computation: ${state.getActionId(fn)}`,
    ]);
    state.filterStats.filtered++;
    state.pending.delete(fn);
    return true;
  }

  // Check throttle: skip recently-run actions but keep them dirty
  // They'll be pulled next time an effect needs them (if throttle expired)
  if (state.isThrottled(fn)) {
    logger.debug("schedule-throttle", () => [
      `[THROTTLE] Skipping throttled action: ${state.getActionId(fn)}`,
    ]);
    state.filterStats.filtered++;
    // Don't clear from pending or dirty - action stays in its current state
    // but we remove from pending so it doesn't run this cycle
    state.pending.delete(fn);
    return true;
  }

  const nextEligibleAt = state.getNextEligibleRunTime(fn);
  if (nextEligibleAt !== undefined && nextEligibleAt > performance.now()) {
    logger.debug("schedule-backoff", () => [
      `[GATE] Skipping time-gated action: ${state.getActionId(fn)}`,
    ]);
    state.filterStats.filtered++;
    state.pending.delete(fn);
    return true;
  }

  return false;
}

function minDefined(
  current: number | undefined,
  next: number | undefined,
): number | undefined {
  if (next === undefined) return current;
  return current === undefined ? next : Math.min(current, next);
}
