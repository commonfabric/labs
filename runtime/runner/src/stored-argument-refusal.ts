/**
 * How setup's refusal of a piece's stored argument is recognized.
 *
 * A leaf of its own so that both sides of the client boundary can classify
 * that refusal. The runtime raises it; a client showing the failure has to
 * tell it from every other reason an operation did not happen, because it is
 * the one that no confirmation can get past.
 */

/**
 * Prefix of the error setup throws when a piece's stored argument does not
 * satisfy the argument schema of the pattern being installed.
 *
 * Exported so a caller can CLASSIFY that failure rather than match on prose. It
 * is code-controlled and sits at the START of the message — a validation detail
 * carrying user-influenced text is appended after it — so a value that merely
 * contains this string cannot forge the classification.
 */
export const STORED_ARGUMENT_SCHEMA_REFUSAL =
  "updated arguments do not match the candidate schema";

/**
 * Whether `error` is setup refusing a piece's stored argument.
 *
 * Distinct from a transient commit or storage failure, and callers must treat
 * it differently: re-running the same identity refuses identically, so a boot
 * repair that hits this has to escalate rather than retry (or a root pinned to
 * a version whose schema cannot read its own document never opens again).
 */
export function isStoredArgumentSchemaRefusal(error: unknown): boolean {
  return error instanceof Error &&
    error.message.startsWith(`${STORED_ARGUMENT_SCHEMA_REFUSAL}:`);
}

/**
 * The part of such a message worth reading, with the classifying prefix
 * removed. Anything else is returned unchanged.
 */
export function storedArgumentRefusalDetail(message: string): string {
  const prefix = `${STORED_ARGUMENT_SCHEMA_REFUSAL}: `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}
