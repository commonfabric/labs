# Runtime Errors

## No Direct DOM Access

Patterns run in a sandboxed environment. DOM APIs don't work:

```typescript
// Shown for illustration only.
// Won't work - DOM APIs not available in sandbox
const addItem = handler((_, { items }) => {
  const input = document.getElementById('item-input');  // Error!
  items.push({ title: input.value });
});

// Use cells to capture state (handler at module scope)
const addItem = handler<unknown, { items: Writable<Item[]>; itemTitle: Writable<string> }>(
  (_, { items, itemTitle }) => {
    const value = itemTitle.get();
    if (value.trim()) {
      items.push({ title: value });
      itemTitle.set("");
    }
  }
);

export default pattern<Input, Input>(({ items }) => {
  const itemTitle = new Writable("");
  return {
    [UI]: (
      <div>
        <cf-input $value={itemTitle} />
        <cf-button onClick={addItem({ items, itemTitle })}>Add</cf-button>
      </div>
    ),
    items,
  };
});
```

## A Handler Cannot Fetch

A handler has no `fetch` to call: a compartment endows none, and the name is
withheld from the type libraries, so reaching for one is a compile error rather
than a runtime failure. A request is a reactive node the pattern body declares,
and a handler starts one by writing the cell that node reads. Awaiting inside a
handler blocks the whole UI besides, so the two rules point the same way.

```typescript
// Shown for illustration only.
// Use fetchJson - reactive, non-blocking
// Handler at module scope - just updates the query
const handleSearch = handler<{ detail: { message: string } }, { searchQuery: Writable<string> }>(
  ({ detail }, { searchQuery }) => searchQuery.set(detail.message)
);

export default pattern(({ searchQuery }) => {
  const searchUrl = computed(() =>
    searchQuery ? `/api/search?q=${encodeURIComponent(searchQuery)}` : ""
  );
  const { result, error, pending } = fetchJson({ url: searchUrl });

  return {
    [UI]: (
      <div>
        {pending && <span>Loading...</span>}
        {error && <span>Error: {error}</span>}
        {result && <div>{result}</div>}
        <cf-message-input oncf-send={handleSearch({ searchQuery })} />
      </div>
    ),
  };
});
```

**Rule:** Handlers should be synchronous state changes defined at module scope. Use `fetchJson` for async operations.

## See Also

- @common/concepts/reactivity.md - Reactivity and fetchJson patterns
- @common/concepts/types-and-schemas/writable.md - Cell and Writable types
