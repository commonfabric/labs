import { pattern } from "commonfabric";

interface Item {
  subItems: Array<{ value: string }>;
}

interface Input {
  items: Item[];
}

// FIXTURE: map-receiver-key-lowering
// Verifies: nested .map() calls are both transformed, with receiver lowered to .key()
//   items.map(fn) → items.mapWithPattern(pattern(...), {})
//   item.subItems.map(fn) → item.key("subItems").mapWithPattern(pattern(...), {})
// Context: No captures; receiver expression item.subItems is lowered to item.key("subItems")
const _p = pattern<Input>(({ items }) =>
  items.map((item) => item.subItems.map((subItem) => subItem.value))
);
