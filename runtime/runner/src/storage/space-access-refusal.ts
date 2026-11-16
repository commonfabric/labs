/**
 * Recognizes the error a storage manager reports as its space's refusal of the
 * manager's session. The memory server names that refusal `AuthorizationError`,
 * and names a refused commit, a refused deletion, and a refused verb the same
 * way, each of which leaves the space readable. What tells them apart is where
 * the error was decided, which the error does not carry, so the manager records
 * each one it reports, and a caller holding an error asks here.
 */

/** The errors a storage manager has reported as a space's refusal. */
const spaceAccessRefusals = new WeakSet<Error>();

/**
 * Records `error` as the refusal of a space's session, which a storage manager
 * does for each error its `spaceAccessError()` or `authorizationError()`
 * reports, and returns it.
 */
export function noteSpaceAccessRefusal(error: Error): Error {
  spaceAccessRefusals.add(error);
  return error;
}

/**
 * Whether `error` is one a storage manager reported as a space's refusal of its
 * session: a permanent authorization denial of reading the space, the refusal
 * of a deleted space among them. A transient failure, such as a lost
 * connection or a denial the server marked `retriable`, is never one, and
 * neither is a refusal of one operation in a space the session may still read.
 * Holds of the reported error itself, not of a copy made of it.
 */
export function isSpaceAccessRefusal(error: unknown): boolean {
  return error instanceof Error && spaceAccessRefusals.has(error);
}
