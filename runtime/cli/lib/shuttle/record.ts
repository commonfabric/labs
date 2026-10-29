/**
 * The form the ambient record prints in: one dimension to a line, its name in
 * a column of fixed width and what it holds after that column.
 *
 * `where` is the ambient record's one surface and `pwd` prints two of its
 * dimensions, so the two print one format, and the format is written here
 * once rather than at each of them. What the fixed column buys a reader is a
 * value they can run their eye down; what it buys a caller reading one back
 * is {@link RECORD_LABEL_WIDTH}, a width to slice at rather than a label to
 * spell again.
 *
 * A value is written as it stands, so one holding a line break continues on a
 * line of its own and reads there as another dimension. What keeps the place's
 * two dimensions clear of one is the refusal `place.ts` makes before a part
 * reaches a place; the connection's are the strings this process was launched
 * with, which passed no door, so `connection.ts` holds them to the class a
 * terminal acts on before they arrive here.
 */

/**
 * The column a dimension's value starts at, which is what a label is padded
 * out to. Every label is shorter than this, so a value never touches the name
 * beside it and a caller reading one back slices here.
 */
export const RECORD_LABEL_WIDTH = 10;

/** One dimension of the ambient record, as a line of it prints. */
export interface RecordEntry {
  /** Which dimension this is, in the word `where` names it by. */
  readonly label: string;

  /** What that dimension holds. */
  readonly value: string;
}

/**
 * Returns `entries` written as the ambient record prints them, one to a line
 * and with no trailing break, which is what leaves the caller deciding where
 * the last line ends.
 *
 * @throws Error if a label is too long for the column, which would run the
 * value against the name and leave a reader — and a caller slicing at
 * {@link RECORD_LABEL_WIDTH} — reading one as part of the other.
 */
export function renderRecord(entries: readonly RecordEntry[]): string {
  return entries.map((entry) => {
    if (entry.label.length >= RECORD_LABEL_WIDTH) {
      throw new Error(
        `The record label \`${entry.label}\` is too long for a column of ` +
          `${RECORD_LABEL_WIDTH}.`,
      );
    }
    return `${entry.label.padEnd(RECORD_LABEL_WIDTH)}${entry.value}`;
  }).join("\n");
}
