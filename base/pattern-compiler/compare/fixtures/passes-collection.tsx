/// <cts-enable />
import { computed, pattern, Writable } from "commonfabric";

interface Item {
  title: string;
  done: boolean;
}

// Each `computed` returns the result of a `filter` as it is, and a `map`
// is applied to the `computed`: the output of the `computed` passes the
// derived collection on unchanged.
export default pattern<
  { items: Writable<Item[]>; tags: Writable<string[]> }
>(({ items, tags }) => {
  const open = computed(() => items.get().filter((item) => !item.done));
  // The predicate reads the index, so of two equal values it can drop
  // the first.
  const later = computed(() => tags.get().filter((_tag, index) => index > 0));
  return {
    rows: open.map((item) => item.title + "!"),
    words: later.map((tag) => tag + "!"),
  };
});
