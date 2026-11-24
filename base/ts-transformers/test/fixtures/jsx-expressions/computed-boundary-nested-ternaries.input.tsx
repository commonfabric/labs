import { computed, ifElse, pattern } from "commonfabric";

// FIXTURE: computed-boundary-nested-ternaries
// Verifies: outer branch lowering does not structurally lower nested ternaries inside computed callbacks
//   show ? computed(() => bar ? "B" : "C") : "D" → outer branch lowers, inner ternary stays authored
//   ifElse(show, computed(() => foo ? "A" : bar ? "B" : "C"), "D") → helper-owned branch lowering still preserves the inner ternaries
export const OuterTernary = pattern<{ show: boolean; bar: boolean }>((
  { show, bar },
) => (
  <div>{show ? computed(() => bar ? "B" : "C") : "D"}</div>
));

export const AuthoredIfElse = pattern<{
  show: boolean;
  foo: boolean;
  bar: boolean;
}>(({ show, foo, bar }) =>
  ifElse(show, computed(() => foo ? "A" : bar ? "B" : "C"), "D")
);
