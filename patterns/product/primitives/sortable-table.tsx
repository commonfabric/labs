/**
 * Renders rows in a table and sorts them when a column header is clicked,
 * reversing the order when the same header is clicked again. Columns marked
 * numeric compare as numbers and the rest compare as text.
 *
 * Cells are positional: a row carries `cells`, one string per column, in the
 * order the columns are declared. That is the whole trick. Addressing a cell
 * as `row[column.key]` — indexing a reactive row object by a reactive key —
 * yields the cell object rather than its text, which is what renders every
 * cell as `[object Object]`. A positional array cannot be indexed that way, so
 * the shape rules the defect out instead of relying on the caller to avoid it.
 *
 * @hashtags table, sortable, sorting, columns, rows, grid
 * @keywords sortable table, sort by column, click header, ascending,
 * descending, reorder rows, data table, tabular, spreadsheet, column headers,
 * numeric sort
 */
import {
  action,
  computed,
  Default,
  ifElse,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export interface TableColumn {
  /** Header text, and the handle a sort request names the column by. */
  label: string;

  /** Whether this column's cells compare as numbers rather than as text. */
  numeric: boolean | Default<false>;
}

export interface TableRow {
  /** One string per column, in the order `columns` declares them. */
  cells: string[];
}

export interface SortableTableInput {
  columns?: Writable<TableColumn[] | Default<[]>>;

  /**
   * The rows, in the order they are displayed. Sorting reorders this array in
   * place, so a host that passes its own cell sees the order it clicked and
   * keeps it.
   */
  rows?: Writable<TableRow[] | Default<[]>>;

  /** Shown in place of the table while there are no rows. */
  emptyMessage?: Writable<string | Default<"No rows.">>;
}

export interface SortableTableOutput {
  [NAME]: string;
  [UI]: VNode;
  rows: TableRow[];

  /** Label of the column the rows are currently ordered by, if any. */
  sortBy: string;
  ascending: boolean;
  rowCount: number;
  sortByColumn: Stream<{ label: string }>;
  addRow: Stream<{ cells: string[] }>;
}

/** Where `label` sits among `columns`, or -1 when no column carries it. */
const columnIndex = (columns: readonly TableColumn[], label: string): number =>
  columns.findIndex((column) => column.label === label);

export const SortableTable = pattern<SortableTableInput, SortableTableOutput>(
  ({ columns, rows, emptyMessage }) => {
    // The ordering applied to the rows, used to reverse a repeated sort.
    const sortBy = new Writable("");
    const ascending = new Writable(true);

    // Clicking the sorted column reverses it; any other column sorts by that
    // one, smallest-first.
    const sortByColumn = action(({ label }: { label: string }) => {
      const declared = columns.get();
      const index = columnIndex(declared, label);
      if (index < 0) return;
      const nextAscending = sortBy.get() === label ? !ascending.get() : true;
      const numeric = declared[index]?.numeric === true;
      const direction = nextAscending ? 1 : -1;
      const ordered = [...rows.get()].sort((left, right) => {
        const a = left.cells[index] ?? "";
        const b = right.cells[index] ?? "";
        if (numeric) return ((Number(a) || 0) - (Number(b) || 0)) * direction;
        return a.localeCompare(b) * direction;
      });
      rows.set(ordered.map((row) => ({ cells: [...row.cells] })));
      sortBy.set(label);
      ascending.set(nextAscending);
    });

    const addRow = action(({ cells }: { cells: string[] }) => {
      rows.push({ cells: [...cells] });
    });

    const rowCount = computed(() => rows.get().length);
    const isEmpty = computed(() => rowCount === 0);

    const headerCells = columns.map((column: TableColumn) => (
      <th
        style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
        onClick={() => sortByColumn.send({ label: column.label })}
      >
        {column.label}
      </th>
    ));

    const bodyRows = rows.map((row: TableRow) => (
      <tr>
        {row.cells.map((cell: string) => <td>{cell}</td>)}
      </tr>
    ));

    return {
      [NAME]: computed(() => `Table (${rowCount} rows)`),
      [UI]: (
        <cf-vstack gap="2" padding="3">
          {ifElse(
            isEmpty,
            <cf-empty-state message={emptyMessage} />,
            <cf-table striped hover full-width>
              <thead>
                <tr>{headerCells}</tr>
              </thead>
              <tbody>{bodyRows}</tbody>
            </cf-table>,
          )}
        </cf-vstack>
      ),
      rows,
      sortBy,
      ascending,
      rowCount,
      sortByColumn,
      addRow,
    };
  },
);

export default SortableTable;
