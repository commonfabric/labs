import { NAME, pattern, UI, type VNode } from "commonfabric";

interface Entry {
  piece: string;
  name: string;
  backlinks: string[];
}

interface Input {
  filtered: Entry[];
}

interface RowInput {
  piece: string;
  name: string;
  backlinks: string[];
}

interface RowOutput {
  rendered: string;
  [UI]: VNode;
  [NAME]: string;
}

const EntryRow = pattern<RowInput, RowOutput>((input) => ({
  rendered: input.piece,
  [UI]: <div />,
  [NAME]: input.name,
}));

// FIXTURE: map-pattern-factory-result-key-access (CT-1586)
// Verifies: `row[K]` where K is a well-known CF computed key (UI or NAME)
// and row is a pattern-factory result inside a JSX-context map callback
// lowers to `row.key(__cfHelpers.K)` — not a lift-applied wrapper.
// Context: `EntryRow(...)` is recognized as an opaque-origin call via
// structural pattern-factory detection, so `row` is tracked as a local
// opaque binding. The reordered visitor in pattern-body-reactive-root-
// lowering lets tracked-opaque static-key access take precedence over the
// JSX dynamic-wrap heuristic. Covers both UI and NAME on the same row to
// exercise the common well-known-key cases through the same fix path.
export default pattern<Input>(({ filtered }) => ({
  [UI]: (
    <div>
      {filtered.map((entry) => {
        const row = EntryRow({
          piece: entry.piece,
          name: entry.name,
          backlinks: entry.backlinks,
        });
        return {
          ui: row[UI],
          n: row[NAME],
        };
      })}
    </div>
  ),
}));
