/**
 * Matches each character a line of the operator's log carries escaped: a
 * control character (C0, DEL and C1), the line and the paragraph separator,
 * and a character that sets or overrides the direction text is laid out in.
 * Every one of them is in the Basic Multilingual Plane.
 */
const ESCAPED_IN_OPERATOR_LOG = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu;

/**
 * Returns `text` as one line that is safe to write to the operator's log and
 * to read in a terminal, whatever `text` was composed from: each character
 * that ends a line, starts a terminal control sequence or reorders the text
 * around it is replaced by its `\uXXXX` escape, and every other character is
 * kept as it is.
 *
 * The escape is not reversible by itself, since a backslash in `text` is
 * kept: a caller that needs to tell an escape from the same six characters
 * in the original quotes the original first, as `JSON.stringify()` does.
 */
export function escapeForOperatorLog(text: string): string {
  return text.replace(
    ESCAPED_IN_OPERATOR_LOG,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
