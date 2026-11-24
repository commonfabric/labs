import { type Default, pattern, type Writable } from "commonfabric";

// FIXTURE: cell-get-unknown-member-result
// Verifies: a pattern-scope `.get()` of a cell whose type CONTAINS `unknown`
// lowers to a lift whose RESULT schema keeps the read's declared shape. The
// read prints its type as `Readonly<{…}>`, or as a tuple, and schema
// generation reads the printed node by the type it was printed from: the
// object keeps every member, rather than the empty object of the library
// alias's UNINSTANTIATED declared type, and the tuple becomes an array of its
// element union, which `unknown` absorbs, rather than the accept-anything
// fallback (`true`).

export default pattern<
  {
    entry: Writable<{ topic: unknown; title: string } | Default<{ topic: null; title: "" }>>;
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
