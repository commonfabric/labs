import { pattern, Writable } from "commonfabric";

// FIXTURE: cell-get-binding-autowrap
// Verifies: a `cell.get()` that feeds a chained computation at a
//   variable-initializer binding is auto-wrapped into a lift, the same way it is
//   in a JSX expression. A read with no lowerable container site at all — a bare
//   `cell.get();` statement — is still rejected with `pattern-context:get-call`.
// Context: lets an author drop a `computed()` wrapper and write the plain
//   expression even when the input is a Writable/Cell. The terminal-read
//   spellings of the same binding are covered by
//   `cell-get-terminal-binding-autowrap`.
export default pattern<{
  layout: Writable<string>;
}>(({ layout }) => {
  const len = layout.get().trim().length;
  return { len };
});
