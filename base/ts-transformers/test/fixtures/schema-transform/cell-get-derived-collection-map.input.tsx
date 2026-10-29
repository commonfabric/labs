import { pattern, UI, Writable } from "commonfabric";

interface Row {
  label: string;
  keep: boolean;
}

// FIXTURE: cell-get-derived-collection-map
// Verifies: a local bound to a cell-read chain (`rows.get().filter(...)`) is a
//   site-lifted reactive collection, and every array-method consumer of it
//   lowers coherently — a JSX map at the expression root, a JSX map nested in
//   a ternary branch, and a value-position map each rewrite to
//   `.mapWithPattern` with no second lift wrapped around the rewritten call
//   and no callback parameter appearing among any lift's inputs.
// Context: the root map lowers through the deferred-JSX route, which reads
//   the closure stage's registry; the nested map lowers through the
//   control-flow rewrite, whose wrap decision recognizes the symbol-less
//   `*WithPattern` spelling structurally; the value-position map keeps its
//   `.for()` naming on the rewritten chain. `hasAny` pins the
//   boolean-consumer lift over the same local.
export default pattern<{ rows: Writable<Row[]> }>(({ rows }) => {
  const view = rows.get().filter((r) => r.keep);
  const hasAny = view.length > 0;
  const labels = view.map((v) => v.label);
  return {
    [UI]: (
      <section>
        <ul>
          {view.map((v) => <li>{v.label}</li>)}
        </ul>
        {hasAny
          ? (
            <div>
              {view.map((v) => <em>{v.label}</em>)}
            </div>
          )
          : null}
      </section>
    ),
    labels,
  };
});
