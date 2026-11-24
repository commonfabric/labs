/// <cts-enable />
import { computed, pattern, Writable } from "commonfabric";

// A `filter` over an array a computation builds in memory: `items` holds
// nothing, so `items.get() || [...]` is the array written at the right,
// whose elements are at no stored position.
export default pattern<
  { items?: Writable<{ done: boolean; text: string }[]> }
>(
  ({ items }) => {
    const summary = computed(() => {
      const list = items?.get() ||
        [{ done: true, text: "a" }, { done: false, text: "b" }];
      return `${list.filter((item) => item.done).length}`;
    });
    return { summary };
  },
);
