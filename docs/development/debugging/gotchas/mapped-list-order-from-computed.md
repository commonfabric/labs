# A mapped list reorders in a `computed()` and the rows never move

**Symptom:** A list or table renders the right content, and a control that
changes only its *order* appears to do nothing. Sort state updates — the header
caret flips, a "sorted by" label changes — and the rows underneath stay exactly
where they were. No compile error, no runtime error, and the very same code
produces the correct order on first paint if the order is set before the piece
runs.

```tsx
// Shown for illustration only.
const sortedRows = computed(() => orderBy(rows.get(), sortBy.get()));
const bodyRows = sortedRows.map((row) => <tr>{row.cells.map((c) => <td>{c}</td>)}</tr>);

const sortByColumn = action(({ label }: { label: string }) => {
  sortBy.set(label); // the caret follows this; the rows do not
});
```

## Why

**A mapped list tracks the cell it maps.** `bodyRows` is built from `rows` by
way of a derived value, and the click changed `sortBy` — never `rows`. Nothing
the renderer watches changed, so nothing re-rendered.

Every reactive piece here is working. `sortBy` updates, and a `computed()`
written directly into the JSX — the caret — re-evaluates and shows the new
state. The order simply lives somewhere the renderer is not watching, which is
why the failure reads as "reactivity is broken for the rows but fine for the
header" rather than as a missing dependency.

Setting the order *before* the piece runs works, and is the observation that
localizes this fastest: the derived value is evaluated once and its first
result is correct. What never happens is the second evaluation.

## Fix

Put the order in the cell the list maps, and write it there:

```tsx
// Shown for illustration only.
const bodyRows = rows.map((row) => <tr>{row.cells.map((c) => <td>{c}</td>)}</tr>);

const sortByColumn = action(({ label }: { label: string }) => {
  rows.set(orderBy(rows.get(), label)); // the rows cell changed, so the rows re-render
  sortBy.set(label);
});
```

Sorting a table is a reordering of its rows, so this is also the more honest
model: `sortBy` becomes a record of the ordering already applied rather than an
instruction to apply one, and the caret cannot disagree with the order on
screen. `patterns/product/primitives/sortable-table.tsx` is written this way.

The same holds for any derived *arrangement* of a list — grouping, reversing,
moving an item — as distinct from a derived *membership* (a filter). A filter
changes the mapped cell's contents through that cell, so it re-renders; a
reordering computed off to one side does not.

## Ruling out the neighbours

Two other things produce "the list looks stale", and both are worth excluding
before rewriting anything:

- A **stale UI whose write never landed** — check the cell's actual state first
  rather than rewriting the mutation
  ([browser-stale-ui](./browser-stale-ui.md)).
- A **mapped `computed()` list whose per-row nested `computed` reads a narrower
  scope**, which fails silently for a different reason — the scope follow is
  blocked, not the subscription
  ([persession-read-in-mapped-computed](./persession-read-in-mapped-computed.md)).
  That gotcha and this one share a boundary worth remembering: mapping a live
  cell and mapping a derived list do not behave alike.

Also confirm the server you are testing against was built from the code you are
testing. A toolshed on a diverged commit can throw unrelated errors that look
like pattern bugs; reproduce on a matched build before concluding the pattern is
at fault ([LOCAL_DEV_SERVERS](../../LOCAL_DEV_SERVERS.md)).
