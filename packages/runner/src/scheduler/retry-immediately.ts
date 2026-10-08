/**
 * Thrown to have the scheduler abort the current transaction and re-run the
 * same handler/action, once what the run was missing is in place. Among the
 * runs that throw it:
 *
 * - A run that referenced a pattern space by name
 *   (`PatternFactory.inSpace("name")`) whose DID had not yet been resolved.
 *   Before throwing, the runner resolves the pending name(s) into the
 *   runtime's space-name cache, so the re-run resolves them synchronously and
 *   proceeds normally.
 * - A handler run whose access-list commit (`grantSpaceAccess()`,
 *   `revokeSpaceAccess()`) conflicted with a concurrent change to the list.
 *   The re-run stages its changes again against the list as it now stands.
 *
 * This is an internal control-flow signal, not a user-facing error.
 */
export class RetryImmediately extends Error {
  constructor(message = "Retry action immediately") {
    super(message);
    this.name = "RetryImmediately";
  }
}

/**
 * Thrown when a runtime leaves an `inSpace("name")` target unresolved: no
 * allocation record names the space yet, and the runtime creates none.
 * `Runtime.resolveInSpaceName()` throws it, and so, in place of a plain
 * {@link RetryImmediately}, does the run that named the target. Under
 * server execution only the serving runtime creates a space for a name, so a
 * client's speculative echo of a handler that would create one withdraws
 * rather than running again: the serving runtime's run creates the space, and
 * its consequence replaces the echo. A reactive action is retried as for any
 * other {@link RetryImmediately}, and resolves the name once the record has
 * arrived.
 */
export class InSpaceTargetUnresolved extends RetryImmediately {
  /** Constructs an instance naming the unresolved target `names`. */
  constructor(names: readonly string[]) {
    super(
      `No space is recorded for in-space target names, and this runtime ` +
        `creates none: ${names.join(", ")}`,
    );
    this.name = "InSpaceTargetUnresolved";
  }
}

export function isRetryImmediately(error: unknown): error is RetryImmediately {
  return error instanceof RetryImmediately;
}
