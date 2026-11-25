/// <cts-enable />
import { computed, pattern, Writable } from "commonfabric";

interface Owner {
  name: string;
}

interface Item {
  title: string;
  owner: Owner;
}

// A window of the three newest items, each read whole with the owner it
// links to: an append moves every entry by one position, and each entry
// holds the record of the owner placed before at its position, where the
// items link to one owner.
export default pattern<{ items: Writable<Item[]> }>(({ items }) => ({
  latest: computed(() => items.get().slice(-3)),
}));
