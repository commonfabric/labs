/// <cts-enable />
import { computed, pattern } from "commonfabric";

interface Item {
  title: string;
}

// The length of an array that the argument may not hold yet, as the
// candidates of a `wish` that has not answered: read in the reactive tier,
// and in a `computed` whose body is an expression of it.
export default pattern<
  { items: Item[] },
  { count: number; name: string }
>(({ items }) => ({
  count: items.length,
  name: computed(() => items.length ? `Items: ${items.length}` : "Items"),
}));
