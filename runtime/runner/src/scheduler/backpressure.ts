/**
 * Backpressure policy for committed writes under contention.
 *
 * The runtime is optimistic: a committed write applies locally and is confirmed
 * by the server in the background. The server can reject a commit. Rejections
 * split two ways (see storage/rejection.ts):
 *
 *   - Transient: a stale basis-sequence conflict. Re-running the originating
 *     work against fresh confirmed state and committing again can succeed. Under
 *     sustained contention (for example a space rehydrating while a handler
 *     writes to it) these arrive in bursts.
 *   - Permanent: a commit-time precondition failure (receipt-exists,
 *     origin-committed). Re-running can never succeed and must not happen.
 *
 * A committed write that represents real user intent must converge or fail
 * loudly; it must never be silently dropped. This policy retries a transient
 * conflict with capped exponential backoff so the system slows down rather than
 * busy-looping, and keeps retrying for a bounded window long enough to outlast a
 * contention burst. If the window elapses without the write landing, the failure
 * surfaces as a terminal error rather than vanishing.
 */

import { EVENT_DEFERRAL_DROP_THRESHOLD } from "./constants.ts";

export interface CommitBackpressurePolicy {
  /**
   * Delay before the first retry, in milliseconds. Small by default so the
   * first few retries are near-immediate — a stale-basis conflict usually
   * clears as soon as the fresh confirmed state arrives, and the exponential
   * curve only grows into real spacing once a conflict persists.
   */
  baseDelayMs: number;

  /** Ceiling on the per-retry delay, in milliseconds. */
  maxDelayMs: number;

  /**
   * Fraction of the computed delay subtracted at random, in [0, 1]. 0.5 spreads
   * each delay across the lower 50% of the capped value so concurrent writers
   * contending for the same entity do not retry in lockstep. Subtractive so the
   * delay never exceeds maxDelayMs.
   */
  jitter: number;

  /**
   * Total wall-clock time a transient conflict may be retried before the write
   * surfaces a terminal error, in milliseconds. Measured from the first
   * conflict for a given intent.
   */
  retryWindowMs: number;
}

// baseDelayMs is 25/32: the exponential reaches 25ms at the sixth step (the
// park before the seventh attempt) and then continues 50, 100, 200, 400, 800,
// 1000 (capped). The first retries — 0.78, 1.56, 3.125ms — are sub-5ms and so
// effectively immediate, which is what lets a transient conflict converge fast,
// without a separate immediate-retry count.
export const DEFAULT_COMMIT_BACKPRESSURE: CommitBackpressurePolicy = {
  baseDelayMs: 25 / 32,
  maxDelayMs: 1_000,
  jitter: 0.5,
  retryWindowMs: 30_000,
};

/**
 * Fills in any unset fields from the defaults and clamps each field so the
 * arithmetic stays well-defined: non-negative delays, a cap no lower than the
 * base delay, jitter within [0, 1], and a non-negative window. These clamps keep
 * the policy sane; they are not what prevents silent data loss. The
 * never-silently-dropped guarantee holds for any resolved policy because a
 * transient conflict either converges or surfaces a terminal error. A zero
 * window does not drop a write silently — it makes the first conflict fail
 * terminally instead of being retried (a config-level way to opt out of the
 * retry window, distinct from the per-event `retries: 0` opt-out).
 */
export function resolveCommitBackpressure(
  partial?: Partial<CommitBackpressurePolicy>,
): CommitBackpressurePolicy {
  const merged = { ...DEFAULT_COMMIT_BACKPRESSURE, ...partial };
  const baseDelayMs = Math.max(0, merged.baseDelayMs);
  const maxDelayMs = Math.max(baseDelayMs, merged.maxDelayMs);
  const jitter = Math.min(1, Math.max(0, merged.jitter));
  const retryWindowMs = Math.max(0, merged.retryWindowMs);
  return { baseDelayMs, maxDelayMs, jitter, retryWindowMs };
}

/**
 * Delay before the given retry attempt (1-based), in milliseconds: exponential
 * growth from `baseDelayMs`, capped at `maxDelayMs`, then reduced by up to the
 * `jitter` fraction. The result is in `[capped * (1 - jitter), capped]`, so it
 * decorrelates concurrent writers without ever exceeding `maxDelayMs`.
 */
export function computeBackoffDelayMs(
  attempt: number,
  policy: CommitBackpressurePolicy,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const growth = policy.baseDelayMs * 2 ** exponent;
  const capped = Math.min(policy.maxDelayMs, growth);
  if (policy.jitter === 0) {
    return capped;
  }
  const reduction = capped * policy.jitter * random();
  return Math.max(0, capped - reduction);
}

/**
 * Terminal failure raised when a committed write that represents user intent
 * cannot be made durable: a transient conflict that never converged within the
 * retry window. Surfaced through the scheduler error channel so the UI or
 * handler can react, instead of the write being silently dropped.
 */
export class CommitConvergenceError extends Error {
  readonly attempts: number;
  readonly elapsedMs: number;
  override readonly cause: unknown;

  constructor(
    options: {
      handlerId?: string;
      attempts: number;
      elapsedMs: number;
      cause?: unknown;
    },
  ) {
    const handlerPart = options.handlerId ? ` for ${options.handlerId}` : "";
    super(
      `Committed write${handlerPart} did not converge after ${options.attempts} ` +
        `attempts over ${
          Math.round(options.elapsedMs)
        }ms of sustained conflicts`,
    );
    this.name = "CommitConvergenceError";
    this.attempts = options.attempts;
    this.elapsedMs = options.elapsedMs;
    this.cause = options.cause;
  }
}

/**
 * How many times a client dispatch whose handler body did not run is re-run
 * after a backoff step — a re-run with no load to park on — before the
 * handling fails. A re-run parked on a load waits for that load and is not
 * counted: what the count bounds is waiting for a change nothing has
 * announced, which a permanently unresolvable argument never gets. The
 * requeued event holds the event queue's head while it waits, so this bound
 * is what keeps one such argument from blocking every later event for the
 * whole retry window. It is the serving drain's deferral threshold, so the
 * two budgets move together.
 */
export const HANDLER_NOT_RUN_BACKOFF_LIMIT = EVENT_DEFERRAL_DROP_THRESHOLD;

/**
 * Terminal failure raised when a client event's handler body never ran: every
 * dispatch found the handler's argument unresolved
 * (`tx.dispatchedHandlerNotRun`), so the event was re-run rather than sealed
 * as a skip, and either the retry window is spent or the re-runs with nothing
 * to park on reached `HANDLER_NOT_RUN_BACKOFF_LIMIT`. Surfaced through the scheduler error
 * channel, so a dispatch that never had its effect is an error the caller
 * sees instead of a commit that looks like success.
 */
export class EventHandlerNotRunError extends Error {
  readonly reason: string;
  readonly attempts: number;
  readonly elapsedMs: number;

  constructor(
    options: {
      handlerId?: string;
      reason: string;
      attempts: number;
      elapsedMs: number;
    },
  ) {
    const handlerPart = options.handlerId ? ` for ${options.handlerId}` : "";
    super(
      `Event handler${handlerPart} did not run in ${options.attempts} ` +
        `dispatches over ${Math.round(options.elapsedMs)}ms: ${options.reason}`,
    );
    this.name = "EventHandlerNotRunError";
    this.reason = options.reason;
    this.attempts = options.attempts;
    this.elapsedMs = options.elapsedMs;
  }
}

/**
 * Terminal failure raised when a client event is dropped before dispatch
 * because no handler could be found for its stream: the piece owning the
 * stream did not start, started without a pattern graph, or started and
 * registered nothing for the stream. Surfaced through the scheduler error
 * channel, so a send made from inside a handler, which has no commit callback
 * to settle, is still an error somebody sees.
 */
export class EventDroppedError extends Error {
  readonly streamId: string;
  readonly reason: string;
  readonly attempts: number;

  /**
   * Why the last start attempt did not start the piece, when it did not:
   * the start verdict's own reason (`no-pattern-meta`, `pattern-unloadable`,
   * `chain-cycle`), or `start-failed` for a start that threw.
   */
  readonly pieceStartReason?: string;

  constructor(
    options: {
      streamId: string;
      reason: string;
      attempts: number;
      pieceStartReason?: string;
    },
  ) {
    super(
      `${options.reason} (piece-start attempts: ${options.attempts})`,
    );
    this.name = "EventDroppedError";
    this.streamId = options.streamId;
    this.reason = options.reason;
    this.attempts = options.attempts;
    if (options.pieceStartReason !== undefined) {
      this.pieceStartReason = options.pieceStartReason;
    }
  }
}

/**
 * Terminal failure raised when a client event handler's commit is refused in a
 * way re-running cannot change, and the write is dropped: a non-stale-basis
 * rejection (an authorization denial, a malformed store operation, a transport
 * failure), or a permanent precondition failure. Surfaced through the
 * scheduler error channel, so a send made from inside a handler, which has no
 * commit callback to settle, is still an error somebody sees.
 */
export class EventCommitRefusedError extends Error {
  readonly rejection: "non-retryable" | "permanent";
  override readonly cause: unknown;

  constructor(
    options: {
      handlerId?: string;
      rejection: "non-retryable" | "permanent";
      cause: unknown;
    },
  ) {
    const handlerPart = options.handlerId ? ` for ${options.handlerId}` : "";
    const causeMessage = (options.cause as { message?: unknown } | undefined)
      ?.message;
    super(
      `Event handler commit${handlerPart} was refused (${options.rejection}) ` +
        "and its write dropped" +
        (typeof causeMessage === "string" ? `: ${causeMessage}` : ""),
    );
    this.name = "EventCommitRefusedError";
    this.rejection = options.rejection;
    this.cause = options.cause;
  }
}
