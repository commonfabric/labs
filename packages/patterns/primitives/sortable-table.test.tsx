/**
 * Tests SortableTable: numeric and text ordering, reversal, and that sorting
 * reorders the rows themselves rather than a view beside them.
 *
 * Run: deno task cf test packages/patterns/primitives/sortable-table.test.tsx
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import { findElement, findElementByExactText } from "../test/vnode-helpers.ts";
import SortableTable from "./sortable-table.tsx";

const COLUMNS = [
  { label: "Category", numeric: false },
  { label: "Cost", numeric: true },
];

const ROWS = [
  { cells: ["Lodging", "420.00"] },
  { cells: ["Food", "86.40"] },
  { cells: ["Travel", "132.10"] },
];

export default pattern(() => {
  const table = SortableTable({ columns: COLUMNS, rows: ROWS });
  const empty = SortableTable({ columns: COLUMNS, rows: [] });

  const byCost = action(() => table.sortByColumn.send({ label: "Cost" }));
  const byCategory = action(() =>
    table.sortByColumn.send({ label: "Category" })
  );
  const byNothing = action(() =>
    table.sortByColumn.send({ label: "No such column" })
  );
  const addRow = action(() => table.addRow.send({ cells: ["Food", "9.99"] }));

  return {
    [TESTS]: [
      { assertion: assert(() => table.rowCount === 3) },
      { assertion: assert(() => table.sortBy === "") },
      // As given, until something asks for an order.
      { assertion: assert(() => table.rows[0].cells[0] === "Lodging") },

      // Numeric, so 86.40 sorts below 132.10 rather than above it as text.
      { action: byCost },
      { assertion: assert(() => table.sortBy === "Cost") },
      { assertion: assert(() => table.ascending === true) },
      { assertion: assert(() => table.rows[0].cells[1] === "86.40") },
      { assertion: assert(() => table.rows[2].cells[1] === "420.00") },
      {
        assertion: assert(() =>
          findElementByExactText(table[UI], "th", "Cost") !== undefined
        ),
      },

      // The same header again reverses rather than re-sorting ascending.
      { action: byCost },
      { assertion: assert(() => table.ascending === false) },
      { assertion: assert(() => table.rows[0].cells[1] === "420.00") },

      // A different header sorts by that one, smallest first.
      { action: byCategory },
      { assertion: assert(() => table.sortBy === "Category") },
      { assertion: assert(() => table.ascending === true) },
      { assertion: assert(() => table.rows[0].cells[0] === "Food") },
      { assertion: assert(() => table.rows[2].cells[0] === "Travel") },
      {
        assertion: assert(() =>
          findElementByExactText(table[UI], "th", "Category") !== undefined
        ),
      },

      // A column nobody declared leaves the order and the state alone.
      { action: byNothing },
      { assertion: assert(() => table.sortBy === "Category") },
      { assertion: assert(() => table.rows[0].cells[0] === "Food") },

      { action: addRow },
      { assertion: assert(() => table.rowCount === 4) },

      // `emptyMessage` is documented as shown IN PLACE OF the table, so an
      // empty dataset renders no table and no headers at all.
      { assertion: assert(() => empty.rowCount === 0) },
      {
        assertion: assert(() =>
          findElement(empty[UI], "cf-table") === undefined
        ),
      },
      {
        assertion: assert(() =>
          findElement(empty[UI], "cf-empty-state") !== undefined
        ),
      },
      // The populated one still renders its table.
      {
        assertion: assert(() =>
          findElement(table[UI], "cf-table") !== undefined
        ),
      },
      // The name a piece list shows, which reports the row count.
      { assertion: assert(() => table[NAME] === "Table (4 rows)") },
    ],
  };
});
