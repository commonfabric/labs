import { pattern, UI, Writable } from "commonfabric";

interface Row {
  label: string;
  keep: boolean;
}

// FIXTURE: cell-get-derived-collection-map-paren-builder
// Verifies: parentheses around the pattern builder callback do not change the
//   site-lifted-collection admission — the derived local still registers, and
//   a JSX map over it still lowers to `.mapWithPattern`, exactly as in the
//   unparenthesized spelling (cell-get-derived-collection-map).
// Context: the admission locates the builder call through
//   getCallArgumentPosition, which reads argument positions through
//   transparent parens (§5.7 paren-invariance).
export default pattern<{ rows: Writable<Row[]> }>((({ rows }) => {
  const view = rows.get().filter((r) => r.keep);
  return {
    [UI]: (
      <ul>
        {view.map((v) => <li>{v.label}</li>)}
      </ul>
    ),
    view,
  };
}));
