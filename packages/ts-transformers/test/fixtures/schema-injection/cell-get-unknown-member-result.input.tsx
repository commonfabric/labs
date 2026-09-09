import { type Default, pattern, type Writable } from "commonfabric";

// FIXTURE: cell-get-unknown-member-result
// Verifies: a pattern-scope `.get()` of a cell whose type CONTAINS `unknown`
// lowers to a lift whose RESULT schema keeps the read's declared shape. Such a
// node takes the node-based analyzer — the transformer routes any node that
// contains `unknown` there, so a generic-default `unknown` stays open rather
// than turning reference-only — and the read prints its type as
// `Readonly<{…}>`, or as a tuple. The analyzer applies the library alias to
// its argument and lowers the tuple to an array of its element union; it used
// to resolve the alias to its UNINSTANTIATED declared type (an empty object,
// every member dropped) and to send the tuple to the accept-anything
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
