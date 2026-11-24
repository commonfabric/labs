import {
  Default,
  handler,
  NAME,
  pattern,
  UI,
  wish,
  Writable,
} from "commonfabric";

type Item = { name: string; value: number };

const removeItem = handler<
  Record<string, never>,
  { items: Writable<Default<Item[], []>>; item: Item }
>((_, { items, item }) => {
  items.remove(item);
});

// FIXTURE: map-wish-default-handler-capture
// Verifies: wish<Default<Array<T>, []>>().result maps still lower to mapWithPattern with handler captures
//   wish<Default<Item[], []>>(...).result!.map(fn) -> mapWithPattern(pattern(...), { items: items })
//   removeItem({ items, item })                    -> captures both the reactive array and the current element
// Context: The array comes from wish().result rather than a pattern param or a local cell
export default pattern<Record<string, never>>((_) => {
  const items = wish<Default<Item[], []>>({ query: "#items" }).result!;

  return {
    [NAME]: "Test",
    [UI]: (
      <ul>
        {items.map((item) => (
          <li>
            {item.name}
            <button type="button" onClick={removeItem({ items, item })}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    ),
  };
});
