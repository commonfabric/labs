/**
 * The form of a space's declared kind: a fact about a space that its creator
 * states once, in the space's genesis commit beside its access list, as
 * `docs/features/space-kinds.md` describes. This module holds the form alone,
 * with no dependencies, so that code validating a kind before it creates a
 * space can import it without the rest of the memory protocol.
 */

/** The longest kind a space may declare. */
export const SPACE_KIND_MAX_LENGTH = 32;

/**
 * Whether `value` is a well-formed space kind: a lowercase word of letters and
 * digits that starts with a letter, or several such words joined by single
 * hyphens, at most {@link SPACE_KIND_MAX_LENGTH} characters long, as
 * `fabrichat-room` and `notebook` are. Only the form is checked. What a kind means
 * is up to the code that reads it.
 */
export function isSpaceKind(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= SPACE_KIND_MAX_LENGTH &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
}
