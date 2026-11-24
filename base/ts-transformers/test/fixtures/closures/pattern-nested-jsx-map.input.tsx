/**
 * Test case for nested map transformation inside ternary.
 *
 * The key scenario: `item.tags.map(...)` where `item` is from an outer
 * `mapWithPattern` callback, and the whole thing is inside a ternary
 * that gets wrapped in `ifElse` → lift-applied computation.
 *
 * The inner map on `item.tags` should still be transformed to
 * `mapWithPattern` because `item` comes from a mapWithPattern element,
 * NOT from the lift-applied computation's captures.
 */

import { Cell, computed, Default, pattern, UI } from "commonfabric";

interface Tag {
  name: string;
}

interface Item {
  label: string;
  tags: Tag[];
  selectedIndex: number;
}

interface PatternInput {
  items?: Cell<Default<Item[], []>>;
}

// FIXTURE: pattern-nested-jsx-map
// Verifies: nested .map() calls in JSX both become mapWithPattern, including inside ifElse
//   items.map((item) => ...) → items.mapWithPattern(pattern(...))
//   item.tags.map((tag, i) => ...) → item.key("tags").mapWithPattern(pattern(...), { item: ... })
//   hasItems ? items.map(...) : <p>No items</p> → ifElse(hasItems, items.mapWithPattern(...), <p>No items</p>)
//   i === item.selectedIndex ? "* " : "" → ifElse(lift(...)(...), "* ", "")
// Context: Inner map on item.tags captures `item.selectedIndex` from the outer
//   mapWithPattern, so it must be passed as a param. Ternaries become ifElse at
//   both the outer and inner levels.
export default pattern<PatternInput>(({ items }) => {
  const hasItems = computed(() => items.get().length > 0);

  return {
    [UI]: (
      <div>
        {hasItems ? (
          items.map((item) => (
            <div>
              <strong>{item.label}</strong>
              <ul>
                {item.tags.map((tag, i) => (
                  <li>
                    {i === item.selectedIndex ? "* " : ""}
                    {tag.name}
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <p>No items</p>
        )}
      </div>
    ),
  };
});
