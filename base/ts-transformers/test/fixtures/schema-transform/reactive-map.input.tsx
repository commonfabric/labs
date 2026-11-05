import { pattern } from "commonfabric";

interface TodoItem {
  title: string;
  done: boolean;
}

// FIXTURE: reactive-map
// Verifies: .map() on typed arrays is transformed to .mapWithPattern() with generated schemas
//   items.map((item) => item.title) → items.mapWithPattern(pattern(...))
//   items.map((item, index) => ({...})) → items.mapWithPattern(pattern(...)) with index param
// Context: two .map() calls -- one returning a scalar, one returning an object with index
export default pattern<{ items: TodoItem[] }>(({ items }) => {
  // Map on opaque ref arrays should be transformed to mapWithPattern
  const mapped = items.map((item) => item.title);

  // This should also be transformed
  const filtered = items.map((item, index) => ({
    title: item.title,
    done: item.done,
    position: index,
  }));

  return { mapped, filtered };
});
