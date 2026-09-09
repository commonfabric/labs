import { type Default, pattern, type Writable } from "commonfabric";

// FIXTURE: cell-get-unknown-member-result
// Verifies: a pattern-scope `.get()` of a cell whose type CONTAINS `unknown`
// keeps its reliable Type for the lowered lift's RESULT schema. The read
// types as `Readonly<{…}>` (printed as an alias reference) or as a tuple,
// and the node-based analyzer can instantiate neither: it used to emit an
// empty object for the alias form and `true` for the tuple. `unknown` is a
// deliberate, schemaable declaration, so a node that merely contains one is
// analyzed from its Type like any other.

export default pattern<
  {
    entry: Writable<{ topic: unknown; title: string } | Default<{ topic: null; title: "" }>>;
    // deno-lint-ignore ban-types
    lookup: Writable<Record<string, unknown>>;
    pair: Writable<[unknown, string] | Default<[null, ""]>>;
  },
  { titleLength: number; keyCount: number; pairLength: number }
>(({ entry, lookup, pair }) => {
  const entryView = entry.get();
  const titleLength = entryView.title.length;
  const lookupView = lookup.get();
  const keyCount = Object.keys(lookupView).length;
  const pairView = pair.get();
  const pairLength = pairView.length;
  return { titleLength, keyCount, pairLength };
});
