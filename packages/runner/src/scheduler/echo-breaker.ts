import { getLogger } from "@commonfabric/utils/logger";
import { BoundedKeyMap } from "@commonfabric/utils/cache";
import { type FabricValue, valueEqual } from "@commonfabric/data-model";

import { normalizeCellScope } from "../scope.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import type { ReactivityLog } from "./types.ts";
import {
  ECHO_BACKOFF_BASE_MS,
  ECHO_BACKOFF_MAX_MS,
  ECHO_TRIP_THRESHOLD,
  ECHO_WINDOW_MS,
  MAX_ECHO_PAIRS,
} from "./constants.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

/**
 * One run of a self-referential computation, classified for the breaker: the
 * document the run both read and wrote and was triggered by, a label for the
 * log line, and whether the written value DIFFERED from the value the document
 * held before this run (an echo step) or converged on it (a reset).
 */
export interface EchoStep {
  /** Pair key within the breaker: resolved scope instance plus document id. */
  readonly docKey: string;
  /** `space/id`, for the loud line. */
  readonly docLabel: string;
  /** True when the write overwrote a differing value; false on convergence. */
  readonly changed: boolean;
}

/** A tripped breaker's visible counts (the health route / client summary). */
export interface EchoBreakerStats {
  /** Pairs currently in backoff. */
  readonly active: number;
  /** Trips since construction, escalations included. */
  readonly trips: number;
  /** Echo cycles counted since construction. */
  readonly cyclesObserved: number;
}

/**
 * The delay a trip at `streak` (1-based) backs off to: capped exponential
 * growth from {@link ECHO_BACKOFF_BASE_MS} to {@link ECHO_BACKOFF_MAX_MS}.
 */
export function echoBackoffDelayMs(streak: number): number {
  const exponent = Math.max(0, streak - 1);
  return Math.min(ECHO_BACKOFF_MAX_MS, ECHO_BACKOFF_BASE_MS * 2 ** exponent);
}

/**
 * Classifies a reactive run's committed effect as echo steps
 * (docs/plans/scheduler-remote-echo-breaker.md §1). A document is an echo step
 * for this run when it is in the run's write set, in the run's read set (the
 * self-referential shape — the diff-base read satisfies this), and among the
 * addresses that triggered the run (`invalidCauses` — the run ran BECAUSE this
 * document changed). The step's `changed` is true when the written value
 * differs from the value the document held before the write, aggregated over
 * every path written under the document: the loop overwrites a foreign value,
 * while a convergence writes an equal one.
 *
 * The own-commit-source skip (`invalidation.ts`) has already removed a run
 * triggered by the echo of its OWN commit, so a cause that reaches here is a
 * foreign writer — exactly the loop to bound.
 */
export function computeEchoSteps(
  tx: IExtendedStorageTransaction,
  log: ReactivityLog,
  invalidCauses: readonly IMemorySpaceAddress[] | undefined,
): EchoStep[] {
  if (log.writes.length === 0 || invalidCauses === undefined) return [];
  const causeIds = new Set<string>();
  for (const cause of invalidCauses) causeIds.add(cause.id);
  if (causeIds.size === 0) return [];

  const readIds = new Set<string>();
  for (const read of log.reads) readIds.add(read.id);
  for (const read of log.shallowReads) readIds.add(read.id);

  // One entry per document the run wrote that is both self-read and a trigger;
  // `changed` is the OR over its written paths, so any differing path makes the
  // document an echo step and only an all-equal write is a convergence.
  const byDoc = new Map<string, { label: string; changed: boolean }>();
  const spaces = new Set(log.writes.map((write) => write.space));
  for (const space of spaces) {
    const details = tx.getWriteDetails?.(space);
    if (details === undefined) continue;
    for (const detail of details) {
      const address = detail.address;
      if (!causeIds.has(address.id) || !readIds.has(address.id)) continue;
      const instance = address.scopeKey ?? normalizeCellScope(address.scope);
      const docKey = `${instance}\u0000${address.id}`;
      const changed = !valueEqual(
        detail.previousValue as FabricValue,
        detail.value as FabricValue,
      );
      const existing = byDoc.get(docKey);
      if (existing === undefined) {
        byDoc.set(docKey, { label: `${space}/${address.id}`, changed });
      } else if (changed) {
        existing.changed = true;
      }
    }
  }

  return [...byDoc].map(([docKey, { label, changed }]) => ({
    docKey,
    docLabel: label,
    changed,
  }));
}

interface EchoPairState {
  windowStart: number;
  cycles: number;
  tripped: boolean;
  backoffStreak: number;
}

/** Separates the action id from the document key in a pair key. */
const PAIR_SEPARATOR = "\u001F";

/**
 * Bounds the remote-echo write loop (docs/plans/scheduler-remote-echo-breaker.md):
 * a reactive computation that writes a document, sees a remote change to that
 * document re-trigger it, and writes again, because another session is writing
 * the same document from the other side. Each run succeeds and commits, so the
 * retry budget and committed-write backpressure never see it; this counts the
 * successful re-runs instead and backs the action off once they sustain.
 *
 * State is per `(action, document)` pair: the breaker trips a pair after
 * {@link ECHO_TRIP_THRESHOLD} echo cycles within {@link ECHO_WINDOW_MS}, and a
 * convergence step or a lapsed window resets it. The table is bounded
 * ({@link MAX_ECHO_PAIRS}); a lost entry costs only a forgotten count.
 */
export class RemoteEchoBreaker {
  #active = 0;
  #trips = 0;
  #cyclesObserved = 0;

  readonly #pairs: BoundedKeyMap<string, EchoPairState>;

  /** Constructs a breaker holding at most {@link MAX_ECHO_PAIRS} pair states. */
  constructor() {
    this.#pairs = new BoundedKeyMap<string, EchoPairState>(MAX_ECHO_PAIRS, {
      onEvict: (_key, state) => {
        if (state.tripped) this.#active--;
      },
    });
  }

  //
  // Instance members
  //

  /**
   * A test's view of the breaker's internals: the current state of a pair, and
   * the live count of pairs in backoff.
   */
  get accessForTestingOnly(): {
    pairCount: number;
    pairState(actionId: string, docKey: string): EchoPairState | undefined;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get pairCount() {
        return outerThis.#pairs.size;
      },
      pairState: (actionId, docKey) =>
        outerThis.#pairs.get(`${actionId}${PAIR_SEPARATOR}${docKey}`),
    };
  }

  /**
   * Records a committed run's echo steps and returns the action's echo-backoff
   * deadline to apply: a positive instant to defer re-runs until (a trip), `0`
   * to clear the deferral (a convergence that left no pair tripped), or
   * `undefined` to leave the gate as it is. `now` is the caller's clock, so the
   * breaker holds no timer of its own.
   */
  observe(
    actionId: string,
    steps: readonly EchoStep[],
    now: number,
  ): number | undefined {
    let maxTripDeadline: number | undefined;
    let clearedTripped = false;

    for (const step of steps) {
      const key = `${actionId}${PAIR_SEPARATOR}${step.docKey}`;
      if (!step.changed) {
        const state = this.#pairs.get(key);
        if (state?.tripped) {
          this.#active--;
          clearedTripped = true;
        }
        this.#pairs.delete(key);
        continue;
      }

      this.#cyclesObserved++;
      const state = this.#pairs.get(key) ??
        { windowStart: now, cycles: 0, tripped: false, backoffStreak: 0 };
      if (now - state.windowStart > ECHO_WINDOW_MS) {
        state.windowStart = now;
        state.cycles = 0;
      }
      state.cycles++;

      if (state.cycles >= ECHO_TRIP_THRESHOLD) {
        if (!state.tripped) {
          state.tripped = true;
          this.#active++;
        }
        state.backoffStreak++;
        this.#trips++;
        const delay = echoBackoffDelayMs(state.backoffStreak);
        const deadline = now + delay;
        maxTripDeadline = maxTripDeadline === undefined
          ? deadline
          : Math.max(maxTripDeadline, deadline);
        // A fresh window for the next escalation, so a tripped pair needs
        // another full threshold of echoes before it backs off further.
        state.windowStart = now;
        state.cycles = 0;
        logger.error("remote-echo-breaker-tripped", () => [
          `action ${actionId} rewrote document ${step.docLabel} ` +
          `${ECHO_TRIP_THRESHOLD} times in ${ECHO_WINDOW_MS}ms against a ` +
          `remote writer; backing off to ${delay}ms`,
        ]);
      }
      this.#pairs.set(key, state);
    }

    if (maxTripDeadline !== undefined) return maxTripDeadline;
    if (clearedTripped && !this.#hasTrippedPair(actionId)) return 0;
    return undefined;
  }

  /** Drops every pair for a removed or retired action. */
  forget(actionId: string): void {
    const prefix = `${actionId}${PAIR_SEPARATOR}`;
    const stale: string[] = [];
    for (const [key, state] of this.#pairs.entries()) {
      if (!key.startsWith(prefix)) continue;
      stale.push(key);
      if (state.tripped) this.#active--;
    }
    for (const key of stale) this.#pairs.delete(key);
  }

  /** The counts a tripped breaker is visible through. */
  stats(): EchoBreakerStats {
    return {
      active: this.#active,
      trips: this.#trips,
      cyclesObserved: this.#cyclesObserved,
    };
  }

  #hasTrippedPair(actionId: string): boolean {
    const prefix = `${actionId}${PAIR_SEPARATOR}`;
    for (const [key, state] of this.#pairs.entries()) {
      if (key.startsWith(prefix) && state.tripped) return true;
    }
    return false;
  }
}
