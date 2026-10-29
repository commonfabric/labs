import { pattern, UI, type VNode } from "commonfabric";

interface RowInput {
  piece: string;
}

interface RowOutput {
  rendered: string;
  extra: string;
}

interface Input extends RowInput {
  field: "rendered";
  entries: RowInput[];
}

interface Output {
  direct: string;
  chosen: string;
  rows: { direct: string }[];
  [UI]: VNode;
}

const Row = pattern<RowInput, RowOutput>((input) => ({
  rendered: input.piece,
  extra: input.piece,
}));

const KEY = "rendered";

// FIXTURE: pattern-body-literal-typed-key-access
// Verifies: `row[KEY]`, where KEY is a `const` of a single literal type,
// lowers to `row.key(KEY)` in the pattern body, in JSX, and in a collection
// callback alike, the key evaluated where the read is
//   direct: row[KEY]      → row.key(KEY)
//   <div>{row[KEY]}</div> → <div>{row.key(KEY)}</div>
// Context: a key read from a reactive value is not fixed by its type, so
// `row[field]` stays a lift over `row` and `field`
export default pattern<Input, Output>(({ piece, field, entries }) => {
  const row = Row({ piece });
  return {
    direct: row[KEY],
    chosen: row[field],
    rows: entries.map((entry) => {
      const inner = Row({ piece: entry.piece });
      return { direct: inner[KEY] };
    }),
    [UI]: (
      <div>
        {row[KEY]}
        {entries.map((entry) => {
          const inner = Row({ piece: entry.piece });
          return <span>{inner[KEY]}</span>;
        })}
      </div>
    ),
  };
});
