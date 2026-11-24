/// <cts-enable />
import { computed, pattern, Writable } from "commonfabric";

// A `filter` over `items.get() || []`, with `items` an array of plain
// values in place: where `items` holds an array, `||` selects it and the
// `filter` runs over the stored array.
export default pattern<{ items: Writable<{ done: boolean; text: string }[]> }>(
  ({ items }) => {
    const summary = computed(() => {
      const list = items.get() || [];
      return `${list.filter((item) => item.done).length}`;
    });
    return { summary };
  },
);
