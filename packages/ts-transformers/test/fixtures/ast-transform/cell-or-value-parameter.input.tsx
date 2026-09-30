import { handler, pattern, type Writable } from "commonfabric";

interface State {
  maybe: Writable<string> | string;
  out: Writable<unknown>;
}

// FIXTURE: cell-or-value-parameter
// Verifies: an identifier whose type has a plain-value arm beside a cell arm
//   is re-rooted only where it is a reactive node by provenance
//   pattern body: { p: maybe }  → { p: maybe.for(["q", "p"], true) }
//   handler body: { p: maybe }  → unchanged
// Context: a pattern input is a reactive node whatever its type says, and
//   carries `.for()`; the same state member in a handler is a value that may
//   be the string, on which `.for()` would throw.
const record = handler<void, State>((_, { maybe, out }) => {
  const e = { p: maybe };
  out.set(e);
});

export default pattern<State>(({ maybe, out }) => {
  const q = { p: maybe };
  return { record: record({ maybe, out }), q };
});
