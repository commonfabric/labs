/// <cts-enable />
import { computed, pattern, Writable } from "commonfabric";

interface Item {
  text: string;
  done: boolean;
}

interface Fleet {
  ships?: Item[];
}

// A per-element construct inside the block body of a promoted `computed`
// that names a `const` of the block: as its receiver (`summary`), in its
// callback (`others`), and in the expression of its receiver (`afloat`).
// `items` is an array of plain values in place, and so are the `ships` of
// `fleet` and of `spare`.
export default pattern<
  {
    items: Writable<Item[]>;
    fleet: Fleet;
    spare: Fleet;
    second: boolean;
    skip: string;
  }
>(({ items, fleet, spare, second, skip }) => {
  const summary = computed(() => {
    const list = items.get() || [];
    const total = list.length;
    if (total === 0) return "Empty";
    const done = list.filter((item) => item.done).length;
    return `${done}/${total}`;
  });
  const others = computed(() => {
    const hidden = skip.trim();
    if (hidden === "") return [];
    return (items.get() || []).filter((item) => item.text !== hidden);
  });
  const afloat = computed(() => {
    const mine = second ? spare : fleet;
    if (!mine) return 0;
    const ships = (mine.ships || []).filter((ship) => !ship.done);
    return ships.length;
  });
  return { summary, others, afloat };
});
