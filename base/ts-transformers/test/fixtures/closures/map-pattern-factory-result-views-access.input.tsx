import { NAME, pattern, UI, VIEWS, type VNode } from "commonfabric";

interface Entry {
  piece: string;
}

interface Input {
  entries: Entry[];
}

interface RowView {
  rendered: string;
}

interface RowOutput {
  [UI]: VNode;
  [NAME]: string;
  [VIEWS]: { row: RowView };
}

const EntryRow = pattern<Entry, RowOutput>((input) => ({
  [UI]: <div />,
  [NAME]: input.piece,
  [VIEWS]: { row: { rendered: input.piece } },
}));

// FIXTURE: map-pattern-factory-result-views-access
// Verifies: `row[VIEWS]` on a pattern-factory result inside a JSX-context map
// callback lowers to `row.key(__cfHelpers.VIEWS)`, as `row[NAME]` does, with
// no lift
//   views: row[VIEWS]       → row.key(__cfHelpers.VIEWS)
//   inner: row[VIEWS].row   → row.key(__cfHelpers.VIEWS, "row")
// Context: VIEWS is a well-known key alongside NAME, UI, SELF and FS
export default pattern<Input>(({ entries }) => ({
  [UI]: (
    <div>
      {entries.map((entry) => {
        const row = EntryRow({ piece: entry.piece });
        return {
          views: row[VIEWS],
          inner: row[VIEWS].row,
          n: row[NAME],
        };
      })}
    </div>
  ),
}));
