import { handler, pattern, type Writable } from "commonfabric";

interface State {
  maybe: Writable<string> | string;
  each: (Writable<string> | string)[];
  out: Writable<unknown>;
}

// FIXTURE: cell-or-value-parameter
// Verifies: an identifier whose type has a plain-value arm beside a cell arm
//   is re-rooted only where it is a reactive node by provenance
//   pattern body: { p: maybe }           → { p: maybe.for(["q", "p"], true) }
//   pattern body: { p: alias }           → { p: alias.for(["viaAlias", "p"], true) },
//                                          `const alias = maybe` being the
//                                          same node under another name
//   reactive `.map()`: { p: item }       → { p: item.for(["__patternResult", "p"], true) }
//   parenthesized callback: { p: maybe } → { p: maybe.for(["q", "p"], true) }
//   handler body: { p: maybe }, { p: alias }
//                                        → unchanged
//   plain function, declared or bound to a `const`: { p: value }
//                                        → unchanged
// Context: a pattern input is a reactive node whatever its type says, and
//   carries `.for()`; the same state member in a handler, or a plain
//   function's parameter, is a value that may be the string, on which
//   `.for()` would throw.
function boxDeclared(value: Writable<string> | string) {
  const boxed = { p: value };
  return boxed;
}

const boxBound = (value: Writable<string> | string) => {
  const boxed = { p: value };
  return boxed;
};

const record = handler<void, State>((_, { maybe, out }) => {
  const alias = maybe;
  const e = { p: maybe };
  const viaAlias = { p: alias };
  out.set([e, viaAlias, boxDeclared(maybe), boxBound(maybe)]);
});

export const parenthesized = pattern<State>((({ maybe }) => {
  const q = { p: maybe };
  return { q };
}));

export default pattern<State>(({ maybe, each, out }) => {
  const alias = maybe;
  const q = { p: maybe };
  const viaAlias = { p: alias };
  const rows = each.map((item) => ({ p: item }));
  return { record: record({ maybe, each, out }), q, viaAlias, rows };
});
