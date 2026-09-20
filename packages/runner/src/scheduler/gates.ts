import type { ActionStats } from "../telemetry.ts";
import {
  AUTO_DEBOUNCE_DELAY_MS,
  AUTO_DEBOUNCE_MIN_RUNS,
  AUTO_DEBOUNCE_THRESHOLD_MS,
} from "./constants.ts";
import type {
  NodeRegistry,
  SchedulerGateState,
  SchedulerNode,
} from "./node-record.ts";
import type { Action } from "./types.ts";

interface DebouncedComputationContext {
  readonly computations: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly isInvalid: (action: Action) => boolean;
  readonly pending: Set<Action>;
  readonly queueExecution: () => void;
  readonly logDebounce: (message: string) => void;
  readonly shouldDebounceFirstRun?: (action: Action) => boolean;
}

export class SchedulerGates {
  readonly #stagedGates = new WeakMap<Action, SchedulerGateState>();
  #wakeTimer: ReturnType<typeof setTimeout> | null = null;
  #wakeAt: number | null = null;

  readonly #state: {
    readonly nodes: NodeRegistry;
    readonly actionStats: ReadonlyMap<string, ActionStats>;
    readonly getActionId: (action: Action) => string;
    readonly isDisposed: () => boolean;
    readonly queueExecution: () => void;
  };

  constructor(
    state: {
      readonly nodes: NodeRegistry;
      readonly actionStats: ReadonlyMap<string, ActionStats>;
      readonly getActionId: (action: Action) => string;
      readonly isDisposed: () => boolean;
      readonly queueExecution: () => void;
    },
  ) {
    this.#state = state;
  }

  /**
   * Hold a just-registered action's initial run until `notBefore` (used for
   * the resume-from-synced-state hold, bounded by its timeout). Expressed as a
   * backoff gate so every eligibility check (seeds, settle skip, preflight
   * parking, idle) already honors it (P8: policies are time gates). The hold
   * is released early via releaseInitialRunHold when the space sync completes.
   */
  holdInitialRun(action: Action, notBefore: number): void {
    const gate = this.#mutableGate(action);
    gate.backoffUntil = Math.max(gate.backoffUntil ?? 0, notBefore);
    this.scheduleWake(notBefore);
  }

  releaseInitialRunHold(action: Action): void {
    const record = this.#state.nodes.get(action);
    if (!record?.gate?.backoffUntil) return;
    record.gate.backoffUntil = 0;
    this.recomputeWakeAfterClear();
  }

  adopt(action: Action): void {
    const record = this.#state.nodes.get(action);
    const staged = this.#stagedGates.get(action);
    if (!record || !staged) return;
    record.gate = { ...record.gate, ...staged };
    this.#stagedGates.delete(action);
  }

  setDebounce(action: Action, ms: number): void {
    const gate = this.#mutableGate(action);
    if (ms <= 0) {
      delete gate.debounceMs;
      this.clearComputationDebounceState(action);
      this.recomputeWakeAfterClear();
    } else {
      const previousReadyAt = gate.debounceReadyAt;
      gate.debounceMs = ms;
      if (previousReadyAt !== undefined) {
        gate.debounceReadyAt = Math.min(
          previousReadyAt,
          performance.now() + ms,
        );
        if (gate.debounceReadyAt < previousReadyAt) {
          this.recomputeWakeAfterClear();
        }
      }
    }
  }

  getDebounce(action: Action): number | undefined {
    return this.#gate(action)?.debounceMs;
  }

  clearDebounce(action: Action): void {
    const gate = this.#gate(action);
    if (gate) delete gate.debounceMs;
    this.cancelDebounceTimer(action);
    this.clearComputationDebounceState(action, { cancelTimer: false });
    this.recomputeWakeAfterClear();
  }

  setNoDebounce(action: Action, optOut: boolean): void {
    const gate = this.#mutableGate(action);
    if (optOut) {
      gate.noAutoDebounce = true;
    } else {
      delete gate.noAutoDebounce;
    }
  }

  getNoDebounce(action: Action): boolean | undefined {
    return this.#gate(action)?.noAutoDebounce ? true : undefined;
  }

  canAutomaticallyDebounce(
    action: Action,
    context: {
      readonly effects: ReadonlySet<Action>;
    },
  ): boolean {
    if (this.#gate(action)?.noAutoDebounce) return false;
    return context.effects.has(action);
  }

  maybeAutoDebounce(
    action: Action,
    context: {
      readonly canAutomaticallyDebounce: (action: Action) => boolean;
    },
  ):
    | {
      actionId: string;
      averageTime: number;
      delayMs: number;
      thresholdMs: number;
    }
    | undefined {
    if (!context.canAutomaticallyDebounce(action)) return undefined;

    const gate = this.#mutableGate(action);
    if (gate.debounceMs !== undefined) return undefined;

    const actionId = this.#state.getActionId(action);
    const stats = this.#state.actionStats.get(actionId);
    if (!stats) return undefined;
    if (stats.runCount < AUTO_DEBOUNCE_MIN_RUNS) return undefined;
    if (stats.averageTime < AUTO_DEBOUNCE_THRESHOLD_MS) return undefined;

    gate.debounceMs = AUTO_DEBOUNCE_DELAY_MS;
    return {
      actionId,
      averageTime: stats.averageTime,
      delayMs: AUTO_DEBOUNCE_DELAY_MS,
      thresholdMs: AUTO_DEBOUNCE_THRESHOLD_MS,
    };
  }

  markActionHasRun(action: Action): void {
    const gate = this.#gate(action);
    if (gate) delete gate.debounceReadyAt;
    this.#armThrottleFromStats(action);
  }

  onInvalidated(
    node: SchedulerNode,
    now = performance.now(),
    context?: DebouncedComputationContext,
  ): void {
    if (
      node.gate.retryOwed || !context ||
      !this.#shouldDebouncePullComputation(node.action, context)
    ) {
      return;
    }
    this.#armComputationDebounce(node.action, context, now);
  }

  onRunCompleted(
    node: SchedulerNode,
    context: {
      readonly canAutomaticallyDebounce: (action: Action) => boolean;
    },
    _now = performance.now(),
  ):
    | {
      actionId: string;
      averageTime: number;
      delayMs: number;
      thresholdMs: number;
    }
    | undefined {
    this.#armThrottleFromStats(node.action);
    return this.maybeAutoDebounce(node.action, context);
  }

  clearComputationDebounceState(
    action: Action,
    options: { cancelTimer?: boolean } = {},
  ): void {
    const gate = this.#gate(action);
    if (gate) delete gate.debounceReadyAt;
    if (options.cancelTimer ?? true) {
      this.cancelDebounceTimer(action);
    }
  }

  cancelDebounceTimer(action: Action): void {
    const gate = this.#gate(action);
    if (gate) delete gate.debounceReadyAt;
  }

  getNextDebounceRunTime(
    action: Action,
    context: {
      readonly computations: ReadonlySet<Action>;
      readonly effects: ReadonlySet<Action>;
      readonly isInvalid: (action: Action) => boolean;
    },
  ): number | undefined {
    if (!this.#shouldDebouncePullComputation(action, context)) {
      return undefined;
    }
    if (!context.isInvalid(action)) return undefined;
    const readyAt = this.#gate(action)?.debounceReadyAt;
    return readyAt !== undefined && readyAt > performance.now()
      ? readyAt
      : undefined;
  }

  /**
   * Returns whether a debounced computation is waiting. A pure query: arming
   * happens at invalidation time (the facade's `markActionInvalid()` →
   * `onInvalidated()`), never as a side effect of asking.
   */
  isDebouncedComputationWaiting(
    action: Action,
    context: DebouncedComputationContext,
  ): boolean {
    const readyAt = this.getNextDebounceRunTime(action, context);
    return readyAt !== undefined && readyAt > performance.now();
  }

  scheduleWithDebounce(
    action: Action,
    context: {
      readonly pending: Set<Action>;
      readonly queueExecution: () => void;
      readonly logDebounce: (message: string) => void;
    },
  ): void {
    const currentGate = this.#gate(action);
    const debounceMs = currentGate?.debounceMs;

    if (currentGate?.retryOwed || !debounceMs || debounceMs <= 0) {
      context.pending.add(action);
      context.queueExecution();
      return;
    }

    this.cancelDebounceTimer(action);

    const gate = this.#mutableGate(action);
    const readyAt = performance.now() + debounceMs;
    gate.debounceReadyAt = readyAt;
    this.scheduleWake(readyAt);

    context.logDebounce(
      `[DEBOUNCE] Action ${this.#state.getActionId(action)} ` +
        `debounced for ${debounceMs}ms`,
    );
  }

  setThrottle(action: Action, ms: number): void {
    const gate = this.#mutableGate(action);
    const previousReadyAt = gate.throttleReadyAt;
    if (ms <= 0) {
      delete gate.throttleMs;
      delete gate.throttleReadyAt;
      this.recomputeWakeAfterClear();
    } else {
      gate.throttleMs = ms;
      this.#armThrottleFromStats(action);
      if (
        previousReadyAt !== undefined &&
        (gate.throttleReadyAt ?? 0) < previousReadyAt
      ) {
        this.recomputeWakeAfterClear();
      }
    }
  }

  getThrottle(action: Action): number | undefined {
    return this.#gate(action)?.throttleMs;
  }

  clearThrottle(action: Action): void {
    const gate = this.#gate(action);
    if (!gate) return;
    delete gate.throttleMs;
    delete gate.throttleReadyAt;
    this.recomputeWakeAfterClear();
  }

  isThrottled(action: Action, now = performance.now()): boolean {
    const record = this.#state.nodes.get(action);
    if (!record) return false;
    return (record.gate.throttleReadyAt ?? 0) > now;
  }

  eligibleAt(node: SchedulerNode): number {
    return Math.max(
      node.gate.debounceReadyAt ?? 0,
      node.gate.throttleReadyAt ?? 0,
      node.gate.backoffUntil ?? 0,
    );
  }

  isEligible(node: SchedulerNode, now = performance.now()): boolean {
    return now >= this.eligibleAt(node);
  }

  getNextEligibleRunTime(
    action: Action,
    now = performance.now(),
  ): number | undefined {
    const record = this.#state.nodes.get(action);
    if (!record) return undefined;
    const eligibleAt = this.eligibleAt(record);
    return eligibleAt > now ? eligibleAt : undefined;
  }

  nextWake(
    candidates: Iterable<SchedulerNode>,
    now = performance.now(),
  ): number | undefined {
    let wakeAt: number | undefined;
    for (const candidate of candidates) {
      const eligibleAt = this.eligibleAt(candidate);
      if (eligibleAt <= now) continue;
      wakeAt = wakeAt === undefined ? eligibleAt : Math.min(wakeAt, eligibleAt);
    }
    return wakeAt;
  }

  hasActiveDebounceTimer(action: Action): boolean {
    const readyAt = this.#gate(action)?.debounceReadyAt;
    return readyAt !== undefined && readyAt > performance.now();
  }

  scheduleWake(at: number): void {
    if (this.#state.isDisposed()) return;
    if (
      this.#wakeAt !== null && this.#wakeAt <= at && this.#wakeTimer !== null
    ) {
      return;
    }

    this.cancelWake();

    const delay = Math.max(0, at - performance.now());
    this.#wakeAt = at;
    this.#wakeTimer = setTimeout(() => {
      this.#wakeTimer = null;
      this.#wakeAt = null;
      this.#state.queueExecution();
    }, delay);
  }

  cancelWake(): void {
    if (this.#wakeTimer !== null) {
      clearTimeout(this.#wakeTimer);
      this.#wakeTimer = null;
    }
    this.#wakeAt = null;
  }

  hasWakeTimer(): boolean {
    return this.#wakeTimer !== null;
  }

  /**
   * Recompute the single shared wake after a node's gate fields were cleared
   * (e.g. clearing a debounce or unsubscribing a debounced action). The wake is
   * shared across every gated node and parked event, and the cleared node may
   * have been the one it was armed for. `scheduleWake` only ever lowers the
   * deadline, so a stale far wake would otherwise keep idle() blocked until it
   * fires. Cancel it and nudge a fresh execution tick, which re-arms the wake
   * to the true minimum over the remaining live work (or leaves it unarmed so
   * idle() can resolve promptly).
   */
  recomputeWakeAfterClear(): void {
    if (this.#state.isDisposed()) return;
    this.cancelWake();
    this.#state.queueExecution();
  }

  /**
   * Release the freshness gates on `action` for a retry the scheduler owes
   * (`MarkInvalidOptions.retry`): an armed debounce readiness and throttle
   * readiness are cleared and the wake recomputed, so the retry is eligible
   * in the pass queued for it. The convergence backoff (§7.7) stays — it
   * bounds a non-settling graph, and a retry inside one waits its turn like
   * every other run. Further invalidations preserve this release until the
   * owed run starts. The policies apply again to invalidations after that.
   */
  releaseForRetry(action: Action): void {
    const gate = this.#gate(action);
    if (!gate) return;
    gate.retryOwed = true;
    if (
      gate.debounceReadyAt === undefined && gate.throttleReadyAt === undefined
    ) {
      return;
    }
    delete gate.debounceReadyAt;
    delete gate.throttleReadyAt;
    this.recomputeWakeAfterClear();
  }

  clearBackoff(node: SchedulerNode): boolean {
    const clearedDeadline = node.gate.backoffUntil !== undefined;
    delete node.gate.backoffUntil;
    node.gate.backoffStreak = 0;
    node.gate.convergenceHoldPasses = 0;
    return clearedDeadline;
  }

  #armComputationDebounce(
    action: Action,
    context: DebouncedComputationContext,
    now: number,
  ): void {
    const debounceMs = this.#gate(action)?.debounceMs;
    if (!debounceMs || debounceMs <= 0) return;

    this.cancelDebounceTimer(action);

    const gate = this.#mutableGate(action);
    const readyAt = now + debounceMs;
    gate.debounceReadyAt = readyAt;
    this.scheduleWake(readyAt);

    context.logDebounce(
      `[DEBOUNCE] Computation ${this.#state.getActionId(action)} ` +
        `trailing flush scheduled for ${debounceMs}ms`,
    );
  }

  #shouldDebouncePullComputation(
    action: Action,
    context: {
      readonly computations: ReadonlySet<Action>;
      readonly effects: ReadonlySet<Action>;
      readonly shouldDebounceFirstRun?: (action: Action) => boolean;
    },
  ): boolean {
    const gate = this.#gate(action);
    const debounceMs = gate?.debounceMs;
    const hasRun = this.#state.nodes.get(action)?.status !== "never-ran";
    return context.computations.has(action) &&
      !context.effects.has(action) &&
      (hasRun || context.shouldDebounceFirstRun?.(action) === true) &&
      debounceMs !== undefined &&
      debounceMs > 0;
  }

  #armThrottleFromStats(action: Action): void {
    const gate = this.#gate(action);
    const throttleMs = gate?.throttleMs;
    if (!gate || gate.retryOwed || !throttleMs || throttleMs <= 0) {
      if (gate) delete gate.throttleReadyAt;
      return;
    }

    const stats = this.#state.actionStats.get(this.#state.getActionId(action));
    if (!stats) {
      delete gate.throttleReadyAt;
      return;
    }
    gate.throttleReadyAt = stats.lastRunTimestamp + throttleMs;
  }

  #gate(action: Action): SchedulerGateState | undefined {
    return this.#state.nodes.get(action)?.gate ?? this.#stagedGates.get(action);
  }

  #mutableGate(action: Action): SchedulerGateState {
    const record = this.#state.nodes.get(action);
    if (record) return record.gate;

    let gate = this.#stagedGates.get(action);
    if (!gate) {
      gate = { backoffStreak: 0, convergenceHoldPasses: 0 };
      this.#stagedGates.set(action, gate);
    }
    return gate;
  }
}
