/**
 * Scheduler-owned control-flow signal for work that cannot run until an
 * asynchronous prerequisite becomes ready.
 *
 * Unlike {@link RetryImmediately}, this signal never asks the current
 * scheduler turn to wait or consumes an authored retry budget. The scheduler
 * aborts the current transaction and installs a generation-fenced continuation
 * on {@link readiness}. By default the work stays subscribed so a changing
 * factory selection can supersede a cold load; callers waiting on a snapshot
 * of durable state can instead coalesce changes and reread when ready.
 */
export class RetryWhenReady extends Error {
  readonly readiness: Promise<unknown>;
  readonly keepDependenciesWhileWaiting: boolean;

  constructor(
    readiness: PromiseLike<unknown>,
    message = "Retry work when readiness resolves",
    options: { keepDependenciesWhileWaiting?: boolean } = {},
  ) {
    super(message);
    this.name = "RetryWhenReady";
    this.readiness = Promise.resolve(readiness);
    this.keepDependenciesWhileWaiting = options.keepDependenciesWhileWaiting ??
      true;
  }
}

export function isRetryWhenReady(error: unknown): error is RetryWhenReady {
  return error instanceof RetryWhenReady;
}
