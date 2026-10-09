import {
  type EchoBreakerClearReport,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { getLogger } from "@commonfabric/utils/logger";
import { BoundedKeyMap } from "@commonfabric/utils/cache";
import { type FabricValue, valueEqual } from "@commonfabric/data-model";

import { getValueAtPath } from "../path-utils.ts";
import { arraysOverlap } from "../reactive-dependencies.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  TransactionWriteDetail,
} from "../storage/interface.ts";
import { entityKey } from "./keys.ts";
import type { ReactivityLog } from "./types.ts";
import {
  ECHO_BACKOFF_BASE_MS,
  ECHO_BACKOFF_MAX_MS,
  ECHO_QUIET_RESET_MS,
  ECHO_TRIP_THRESHOLD,
  ECHO_WINDOW_MS,
  MAX_ECHO_PAIRS,
} from "./constants.ts";

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

/**
 * One run of a self-referential computation, classified for the breaker: a
 * document the run read and was triggered by, and whether the run changed it
 * (an echo step) or left it as it was (a convergence step).
 */
export interface EchoStep {
  /**
   * The document's complete identity, `space/scope instance/id` — the
   * scheduler's {@link entityKey} — which keys the breaker's pair and names
   * the document in the log line.
   */
  readonly docKey: string;

  /** The document's space, id, and declared scope, for a report of it. */
  readonly document: EchoDocument;

  /** True when the run overwrote a differing value; false on convergence. */
  readonly changed: boolean;
}

/**
 * A document as the breaker reports it: where it lives and which it is,
 * down to the scope instance the run wrote — on a serving runtime, the
 * demanding session's, not the runtime's own.
 */
export interface EchoDocument {
  readonly space: MemorySpace;
  readonly id: string;
  readonly scopeKey: ScopeKey;
}

/**
 * What the breaker tells its owner as it happens: a pair tripped, or a
 * tripped pair cleared — by a convergence step, by its quiet reset, by its
 * action being retired, or by its eviction from the bounded table.
 */
export type EchoBreakerEvent =
  | {
    readonly event: "trip";
    readonly actionId: string;
    readonly document: EchoDocument;
  }
  | {
    readonly event: "clear";
    readonly actionId: string;
    readonly document: EchoDocument;
    readonly reason: EchoBreakerClearReport["reason"];

    /** Echoes after the trip, each of which renewed the backoff. */
    readonly renewals: number;

    /** Milliseconds from the trip to the clear. */
    readonly trippedMs: number;
  };

/** A tripped breaker's visible counts (the health route / client summary). */
export interface EchoBreakerStats {
  /** Pairs whose backoff is in force right now. */
  readonly active: number;

  /**
   * Trips since construction. A pair that clears and later trips again
   * counts again; renewals of a trip in force do not count.
   */
  readonly trips: number;

  /** Echo cycles counted since construction, renewals included. */
  readonly cyclesObserved: number;
}

/**
 * The delay a tripped pair's `streak`th consecutive echo (1-based) backs off
 * to: capped exponential growth from {@link ECHO_BACKOFF_BASE_MS} to
 * {@link ECHO_BACKOFF_MAX_MS}.
 */
export function echoBackoffDelayMs(streak: number): number {
  const exponent = Math.max(0, streak - 1);
  return Math.min(ECHO_BACKOFF_MAX_MS, ECHO_BACKOFF_BASE_MS * 2 ** exponent);
}

/**
 * A committing run as the breaker needs it once the commit lands: the
 * triggers it changed, read off the transaction's write details while they
 * are still staged, and what classifying the rest takes.
 */
export interface EchoRun {
  /** The complete identities of the documents that triggered the run. */
  readonly causeKeys: ReadonlySet<string>;

  /** Those of them the run changed where it was triggered. */
  readonly changed: ReadonlySet<string>;

  /** The run's reactivity log, whose reads pick the candidates. */
  readonly log: ReactivityLog;

  /** The identity the run's addresses resolve against. */
  readonly identity: ScopeKeyIdentity;
}

/**
 * Captures what classifying a reactive run takes, at commit kickoff, while the
 * transaction's write details are still staged — a committed transaction no
 * longer exposes them — or `undefined` for a run nothing triggered.
 *
 * A trigger counts as changed when a write the run made both differs from
 * what it replaced and reaches the path that triggered the run: a write at or
 * below that path, or one above it whose value differs at it. A run that
 * reads one field of a document and writes another field of it has not
 * overwritten its trigger, however often the field it reads changes. A run
 * triggered at the whole document cannot be told apart that way, so any
 * changing write to the document counts for it.
 *
 * Every address is compared by its complete identity — space, scope instance,
 * and id — resolved against `identity`, the one identity the transaction
 * serves: the run's demanded instance on a serving runtime, the runtime's own
 * session everywhere else. Write details name a scope but not its instance,
 * so they resolve through `identity` too.
 *
 * The own-commit-source skip (`invalidation.ts`) has already removed a run
 * triggered by the echo of its OWN commit, so a cause that reaches here is
 * another writer.
 */
export function captureEchoRun(
  tx: Pick<IExtendedStorageTransaction, "getWriteDetails">,
  log: ReactivityLog,
  invalidCauses: readonly IMemorySpaceAddress[] | undefined,
  identity: ScopeKeyIdentity,
): EchoRun | undefined {
  if (invalidCauses === undefined || invalidCauses.length === 0) {
    return undefined;
  }
  const causePaths = new Map<string, (readonly string[])[]>();
  for (const cause of invalidCauses) {
    const key = entityKey(cause, identity);
    const paths = causePaths.get(key);
    if (paths === undefined) causePaths.set(key, [cause.path]);
    else paths.push(cause.path);
  }

  // A run's writes and its triggers are both few, so this pass is cheap.
  const changed = new Set<string>();
  for (const space of new Set(log.writes.map((write) => write.space))) {
    for (const detail of tx.getWriteDetails?.(space) ?? []) {
      const key = entityKey(detail.address, identity);
      if (changed.has(key)) continue;
      const paths = causePaths.get(key);
      if (paths?.some((path) => overwrites(detail, path))) changed.add(key);
    }
  }
  return { causeKeys: new Set(causePaths.keys()), changed, log, identity };
}

/**
 * Classifies a committed run as echo and convergence steps
 * (docs/plans/scheduler-remote-echo-breaker.md §1). The candidates are the
 * documents that triggered the run that the run also read — the
 * self-referential shape, which the write path's diff-base read satisfies. A
 * candidate the run changed is an echo step; one it did not change is a
 * convergence step. Storage drops a write of an equal value before it
 * reaches the write details, so a candidate with no changed write detail is a
 * convergence whether the run wrote the same value again or did not write it
 * at all.
 *
 * `options.tracked` says whether the breaker holds a pair of the run's action
 * now, as the commit lands, rather than when the run began: another run of
 * the action may have started counting in between. An untracked action can
 * only begin counting, which takes an echo step, so only its changed triggers
 * are classified and its reads are scanned only when it has one. The common
 * run — of an action the breaker is not tracking, that did not overwrite its
 * own trigger — costs nothing here.
 */
export function computeEchoSteps(
  run: EchoRun,
  options: { tracked: boolean },
): EchoStep[] {
  if (!options.tracked && run.changed.size === 0) return [];

  // An untracked action needs only its changed triggers confirmed; a tracked
  // one needs every trigger it read, since one it did not change is the
  // convergence that clears a pair.
  const wanted = options.tracked ? run.causeKeys : run.changed;
  const candidates = new Map<string, EchoDocument>();
  for (const read of [...run.log.reads, ...run.log.shallowReads]) {
    const key = entityKey(read, run.identity);
    if (wanted.has(key) && !candidates.has(key)) {
      candidates.set(key, {
        space: read.space,
        id: read.id,
        scopeKey: read.scopeKey ?? resolveScopeKey(read.scope, run.identity),
      });
    }
  }

  return [...candidates].map(([docKey, document]) => ({
    docKey,
    document,
    changed: run.changed.has(docKey),
  }));
}

/**
 * Whether `detail` changed what `path`, a path of the same document that
 * triggered the run, addresses. A write at or below `path` changed it when it
 * changed anything; a write above it, when its value differs at `path`; a
 * write beside it never did.
 */
function overwrites(
  detail: TransactionWriteDetail,
  path: readonly string[],
): boolean {
  const written: readonly string[] = detail.address.path;
  if (!arraysOverlap(written, path)) return false;
  const below = path.slice(written.length);
  return !valueEqual(
    getValueAtPath(detail.previousValue, below) as FabricValue,
    getValueAtPath(detail.value, below) as FabricValue,
  );
}

interface EchoPairState {
  /** When the current counting window opened. */
  windowStart: number;

  /** Echo cycles in the current window, before the pair trips. */
  cycles: number;

  /** Consecutive echoes since the pair tripped; 0 while untripped. */
  backoffStreak: number;

  /** When the pair's most recent echo was counted. */
  lastEchoAt: number;

  /** When the pair's backoff ends; 0 when none was set. */
  deadline: number;

  /** When the pair tripped; 0 while untripped. */
  trippedAt: number;

  /** The document, for the event a clear of the pair reports. */
  document: EchoDocument;
}

/** Separates the action id from the document key in a pair key. */
const PAIR_SEPARATOR = "\u001F";

/** The action id a pair key begins with. */
const actionIdOf = (key: string): string =>
  key.slice(0, key.indexOf(PAIR_SEPARATOR));

/**
 * Bounds the remote-echo write loop (docs/plans/scheduler-remote-echo-breaker.md):
 * a reactive computation that writes a document, sees a remote change to that
 * document re-trigger it, and writes again, because another session is writing
 * the same document from the other side. Each run succeeds and commits, so the
 * retry budget and committed-write backpressure never see it; this counts the
 * successful re-runs instead and backs the action off once they sustain.
 *
 * State is per `(action, document)` pair. An untripped pair trips after
 * {@link ECHO_TRIP_THRESHOLD} echo cycles within {@link ECHO_WINDOW_MS}, and a
 * convergence step or a lapsed window resets its count. A tripped pair renews
 * its backoff one step longer on every further echo, so the rate bound holds
 * at the cap, and is cleared by a convergence step or by
 * {@link ECHO_QUIET_RESET_MS} without an echo. The table is bounded
 * ({@link MAX_ECHO_PAIRS}); a lost entry costs only a forgotten count, and a
 * tripped one is reported cleared.
 */
export class RemoteEchoBreaker {
  #trips = 0;
  #cyclesObserved = 0;

  /** The `now` of the observation in progress, for a clear an eviction
   * reports. */
  #observedAt = 0;

  readonly #pairs = new BoundedKeyMap<string, EchoPairState>(MAX_ECHO_PAIRS, {
    onEvict: (key, state) => {
      const actionId = actionIdOf(key);
      this.#countPair(actionId, -1);
      if (state.backoffStreak > 0) {
        this.#cleared(actionId, state, "evicted", this.#observedAt);
      }
    },
  });

  /** How many pairs each action holds, so `tracks()` is one lookup. */
  readonly #pairsByAction = new Map<string, number>();

  readonly #onEvent: ((event: EchoBreakerEvent) => void) | undefined;

  /**
   * Constructs a breaker that tells `onEvent`, when given, each trip and each
   * clear of a tripped pair, as it happens.
   */
  constructor(
    options: { onEvent?: (event: EchoBreakerEvent) => void } = {},
  ) {
    this.#onEvent = options.onEvent;
  }

  //
  // Instance members
  //

  /** A test's view of the breaker's pair table. */
  get accessForTestingOnly(): {
    readonly pairCount: number;
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
   * Records a committed run's steps and returns the action's echo-backoff
   * deadline to apply: a positive instant to defer re-runs until (a trip or a
   * renewal), `0` to lift the deferral (a convergence that left no other pair
   * of the action in backoff), or `undefined` to leave the gate as it is.
   * `now` is the caller's clock, so the breaker holds no timer of its own.
   */
  observe(
    actionId: string,
    steps: readonly EchoStep[],
    now: number,
  ): number | undefined {
    this.#observedAt = now;
    let maxDeadline: number | undefined;
    let clearedTripped = false;

    for (const step of steps) {
      const key = `${actionId}${PAIR_SEPARATOR}${step.docKey}`;
      const existing = this.#pairs.get(key);
      if (!step.changed) {
        if (existing === undefined) continue;
        if (existing.backoffStreak > 0) {
          clearedTripped = true;
          this.#cleared(actionId, existing, "convergence", now);
        }
        this.#pairs.delete(key);
        this.#countPair(actionId, -1);
        continue;
      }

      this.#cyclesObserved++;
      // A tripped pair that has been quiet longer than any backoff is a loop
      // that ended without a convergence step reaching it; start it afresh.
      const stale = existing !== undefined && existing.backoffStreak > 0 &&
        now - existing.lastEchoAt > ECHO_QUIET_RESET_MS;
      if (stale) this.#cleared(actionId, existing, "quiet", now);
      const state: EchoPairState = existing !== undefined && !stale
        ? existing
        : {
          windowStart: now,
          cycles: 0,
          backoffStreak: 0,
          lastEchoAt: now,
          deadline: 0,
          trippedAt: 0,
          document: step.document,
        };
      state.lastEchoAt = now;

      if (state.backoffStreak > 0) {
        state.backoffStreak++;
        state.deadline = now + echoBackoffDelayMs(state.backoffStreak);
      } else {
        if (now - state.windowStart > ECHO_WINDOW_MS) {
          state.windowStart = now;
          state.cycles = 0;
        }
        state.cycles++;
        if (state.cycles >= ECHO_TRIP_THRESHOLD) {
          state.backoffStreak = 1;
          state.trippedAt = now;
          const delay = echoBackoffDelayMs(1);
          state.deadline = now + delay;
          this.#trips++;
          this.#onEvent?.({
            event: "trip",
            actionId,
            document: step.document,
          });
          logger.error("remote-echo-breaker-tripped", () => [
            `action ${actionId} rewrote document ${step.docKey} ` +
            `${ECHO_TRIP_THRESHOLD} times within ${ECHO_WINDOW_MS}ms against ` +
            `a remote writer; backing off its re-runs, starting at ${delay}ms`,
          ]);
        }
      }
      if (state.backoffStreak > 0) {
        maxDeadline = Math.max(maxDeadline ?? 0, state.deadline);
      }
      if (existing === undefined) this.#countPair(actionId, 1);
      this.#pairs.set(key, state);
    }

    if (maxDeadline !== undefined) return maxDeadline;
    if (clearedTripped && !this.#hasPairInBackoff(actionId, now)) return 0;
    return undefined;
  }

  /**
   * Drops every pair for a removed or retired action, reporting each tripped
   * one as cleared at `now`.
   */
  forget(actionId: string, now: number): void {
    const prefix = `${actionId}${PAIR_SEPARATOR}`;
    const retired = [...this.#pairs.entries()].filter(([key]) =>
      key.startsWith(prefix)
    );
    for (const [key, state] of retired) {
      if (state.backoffStreak > 0) {
        this.#cleared(actionId, state, "retired", now);
      }
      this.#pairs.delete(key);
    }
    this.#pairsByAction.delete(actionId);
  }

  /** Whether the breaker holds any pair of `actionId`. */
  tracks(actionId: string): boolean {
    return this.#pairsByAction.has(actionId);
  }

  /**
   * The counts a tripped breaker is visible through. `active` counts the pairs
   * whose backoff is still in force at `now`, so a loop that ended without a
   * convergence step stops counting once its last deadline passes.
   */
  stats(now: number): EchoBreakerStats {
    let active = 0;
    for (const state of this.#pairs.values()) {
      if (state.deadline > now) active++;
    }
    return {
      active,
      trips: this.#trips,
      cyclesObserved: this.#cyclesObserved,
    };
  }

  /** Adjusts the pairs `actionId` holds by `delta`, forgetting it at none. */
  #countPair(actionId: string, delta: number): void {
    const count = (this.#pairsByAction.get(actionId) ?? 0) + delta;
    if (count > 0) this.#pairsByAction.set(actionId, count);
    else this.#pairsByAction.delete(actionId);
  }

  /** Tells the owner a tripped pair cleared at `now`, and how. */
  #cleared(
    actionId: string,
    state: EchoPairState,
    reason: EchoBreakerClearReport["reason"],
    now: number,
  ): void {
    this.#onEvent?.({
      event: "clear",
      actionId,
      document: state.document,
      reason,
      renewals: state.backoffStreak - 1,
      trippedMs: Math.max(0, Math.round(now - state.trippedAt)),
    });
  }

  #hasPairInBackoff(actionId: string, now: number): boolean {
    const prefix = `${actionId}${PAIR_SEPARATOR}`;
    for (const [key, state] of this.#pairs.entries()) {
      if (key.startsWith(prefix) && state.deadline > now) return true;
    }
    return false;
  }
}
