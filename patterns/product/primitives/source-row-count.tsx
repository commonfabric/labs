/**
 * Counts the rows of one table in a database handed to it: `total` is every
 * row the table holds and `matching` is how many of them satisfy `predicate`,
 * a SQL boolean expression over that table's own columns. An empty predicate
 * counts every row, so `matching` equals `total`. Both numbers come from a
 * single aggregate statement, which returns one row whatever the table
 * holds, and a statement the database refuses reports its own message —
 * `no such table` for a name the store does not carry, `no such column` for a
 * predicate over a column it does not declare. The numbers are derived from
 * the whole table rather than from any one row, so they are disclosed under
 * every label the table's rows carry.
 *
 * @hashtags count, rows, table, total, matching, predicate, sqlite, connector
 * @keywords row count, how many rows, count the rows of a table, total rows,
 * matching rows, count with a predicate, aggregate count, SqliteDb handle
 */
import {
  computed,
  Default,
  ifElse,
  NAME,
  pattern,
  type SqliteDb,
  UI,
  type VNode,
} from "commonfabric";

export interface SourceRowCountInput {
  /** The database to count in. Whoever wired the input chose which. */
  source: SqliteDb;

  /** The table to count, by the name the store declares it under. */
  table: string;

  /**
   * A SQL boolean expression over the table's own columns. Empty counts every
   * row.
   */
  predicate?: string | Default<"">;
}

export interface SourceRowCountOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The table the numbers below were read from. */
  table: string;

  /** The predicate `matching` counted under, empty when it counted every row. */
  predicate: string;

  /** Every row the table holds. */
  total: number;

  /** How many of those rows satisfy `predicate`. */
  matching: number;

  pending: boolean;

  /** Why the read failed, empty while it has not. */
  errorMessage: string;
}

/** One row of the aggregate, under the names the statement gives its columns. */
interface CountRow {
  total: number;
  matching: number;
}

/**
 * `name` as a quoted SQLite identifier, with an embedded quote doubled.
 *
 * A table is named rather than bound: SQLite takes an identifier from the
 * statement text and a parameter only where a value goes. Quoting is what
 * keeps the name a name — every string reaches the database as the identifier
 * it spells, and one the store does not carry comes back as `no such table`
 * rather than as a statement of another shape.
 */
const quotedIdentifier = (name: string): string =>
  `"${name.replace(/"/g, '""')}"`;

/**
 * Both numbers in one statement: `count(*)` over the whole table, and a sum
 * over the predicate, which is one row and therefore one row document.
 *
 * The predicate is parenthesized, so an expression holding `OR` counts the
 * rows it reads as satisfying it rather than widening the sum to every row.
 * An empty predicate becomes the constant true, which is what makes
 * `matching` equal `total` for a caller that names none.
 */
const countSql = (table: string, predicate: string): string =>
  [
    "SELECT count(*) AS total,",
    `  COALESCE(sum(CASE WHEN (${predicate === "" ? "1" : predicate})`,
    "    THEN 1 ELSE 0 END), 0) AS matching",
    `FROM ${quotedIdentifier(table)}`,
  ].join("\n");

/**
 * What a query reports about a failure, empty when it has not failed.
 *
 * The same narrowing the sqlite builtin applies before it writes one, so a
 * value that reaches here already a message passes through unchanged.
 */
const errorText = (error: unknown): string =>
  error === undefined || error === null
    ? ""
    : error instanceof Error
    ? error.message
    : String(error);

export const SourceRowCount = pattern<
  SourceRowCountInput,
  SourceRowCountOutput
>(({ source, table, predicate }) => {
  const countRead = source.query<CountRow>(
    computed(() => countSql(table, predicate)),
    { scope: "session" },
  );

  const total = computed(() => countRead.result?.[0]?.total ?? 0);
  const matching = computed(() => countRead.result?.[0]?.matching ?? 0);
  const pending = computed(() => countRead.pending === true);
  const errorMessage = computed(() => errorText(countRead.error));
  const hasError = computed(() => errorMessage !== "");

  // Both counts fall back to zero while the read is in flight, and `0 of 0` is
  // the one reading this part exists to rule out — a full table that looks
  // empty. So nothing states a count until the read has settled.
  const summary = computed(() =>
    pending ? "counting" : `${matching} of ${total}`
  );

  return {
    [NAME]: computed(() =>
      pending
        ? `counting rows in ${table}`
        : `${matching} of ${total} rows in ${table}`
    ),
    [UI]: (
      <cf-vstack gap="2" padding="3">
        <cf-hstack gap="2" align="center" justify="between">
          <cf-text style="flex: 1;">{table}</cf-text>
          <cf-text style="font-variant-numeric: tabular-nums;">
            {summary}
          </cf-text>
        </cf-hstack>

        {ifElse(
          hasError,
          <cf-alert status="error">{errorMessage}</cf-alert>,
          null,
        )}
      </cf-vstack>
    ),
    table,
    predicate,
    total,
    matching,
    pending,
    errorMessage,
  };
});

export default SourceRowCount;
