import { Cell, handler, ifElse, pattern, UI } from "commonfabric";

interface Item {
  id: number;
  name: string;
}

// Handler that closes over both items array and individual item
const removeItem = handler<
  unknown,
  { items: Cell<Array<Cell<Item>>>; item: Cell<Item> }
>((_event, { items, item }) => {
  const currentItems = items.get();
  const index = currentItems.findIndex((el) => el.equals(item));
  if (index >= 0) {
    items.set(currentItems.toSpliced(index, 1));
  }
});

// FIXTURE: map-inside-ifelse-with-handler
// Verifies: .map() inside an ifElse branch is still transformed to mapWithPattern
//   .map(fn) → .mapWithPattern(pattern(...), {items: ...})
//   hasItems ternary → ifElse(...)
// Context: Map nested inside ifElse; handler references both the items array and iterator variable
export default pattern<{ items: Item[]; hasItems: boolean }>(
  ({ items, hasItems }) => {
    // CT-1035: Map inside ifElse branches should transform to mapWithPattern
    // The handler closure should work correctly with the map iterator variable
    return {
      [UI]: (
        <div>
          {ifElse(
            hasItems,
            <div>
              {items.map((item) => (
                <div>
                  <span>{item.name}</span>
                  <button type="button" onClick={removeItem({ items, item })}>Remove</button>
                </div>
              ))}
            </div>,
            <div>No items</div>
          )}
        </div>
      ),
    };
  },
);
