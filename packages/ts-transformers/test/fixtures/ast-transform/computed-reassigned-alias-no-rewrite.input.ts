import { computed } from "commonfabric";

// FIXTURE: computed-reassigned-alias-no-rewrite
// Verifies: mutable aliases to `computed()` are not treated as stable builder aliases.
// Context: the alias lives in a function, where `let` is ordinary code; module scope allows only `const`
export default function run() {
  let alias = computed;
  alias = ((fn: () => number) => fn()) as typeof alias;
  return alias(() => 1);
}
