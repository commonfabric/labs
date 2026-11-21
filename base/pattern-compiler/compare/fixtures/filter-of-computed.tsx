/// <cts-enable />
import { computed, pattern, Writable } from "commonfabric";

// A `filter` over an array a computation builds in memory, `items.get() ||
// []`: its elements are at no stored position.
export default pattern<{ items: Writable<{ done: boolean; text: string }[]> }>(
  ({ items }) => {
    const summary = computed(() => {
      const list = items.get() || [];
      return `${list.filter((item) => item.done).length}`;
    });
    return { summary };
  },
);
