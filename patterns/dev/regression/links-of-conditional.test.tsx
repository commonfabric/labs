/**
 * A conditional over a row that `linksOf()` returned decides by the row's
 * value: a row whose badge is the empty string renders no badge.
 *
 * The rows are stored in documents of their own, and the board's list holds
 * links to them. A lift takes a prefix of that list through `linksOf()` and
 * returns it as a new array, so each element is written as a link of its own
 * carrying the cell's schema. Mapped, each element's conditional follows that
 * link, and decides by the schema it stores. Were the cell typed by the
 * `unknown` its list was read under, the link would declare the row opaque,
 * and every row's badge would read as present.
 *
 * Run: deno task cf test patterns/dev/regression/links-of-conditional.test.tsx
 */
import {
  assert,
  lift,
  linksOf,
  pattern,
  type ReadonlyCell,
  TESTS,
  Writable,
} from "commonfabric";

interface Row {
  title: string;
  badge: string;
}

/** Two rows, each stored in a document of its own; the first has no badge. */
const rowsOf = lift((_: Record<string, never>): Row[] => {
  const rows: unknown[] = [];
  for (const [index, badge] of ["", "#1"].entries()) {
    rows.push(
      Writable.for<Row>(`row-${index}`).set({ title: `Row ${index}`, badge }),
    );
  }
  return rows as Row[];
});

/** The rows, as the cells `linksOf()` returns, in a new array. */
const shownRowsOf = lift(
  ({ rows }: { rows: ReadonlyCell<Row[]> }): Row[] => {
    const listed: unknown[] = linksOf<Row>(rows) ?? [];
    return listed.slice() as Row[];
  },
);

export default pattern(() => {
  const rows = rowsOf({});
  const shown = shownRowsOf({ rows });

  const hasBadge = shown.map((row) => row.badge ? "yes" : "no");
  const badges = shown.map((row) => row.badge);

  const assert_conditional_reads_the_value = assert(() =>
    hasBadge.join(",") === "no,yes"
  );
  const assert_value_reads_the_value = assert(() => badges.join(",") === ",#1");

  return {
    [TESTS]: [
      { assertion: assert_conditional_reads_the_value },
      { assertion: assert_value_reads_the_value },
    ],
  };
});
