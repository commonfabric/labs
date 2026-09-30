/**
 * Thrown from a handler/action `postRun` to have the scheduler abort the
 * current transaction and re-run the same handler/action. Two things throw it:
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

export function isRetryImmediately(error: unknown): error is RetryImmediately {
  return error instanceof RetryImmediately;
}
