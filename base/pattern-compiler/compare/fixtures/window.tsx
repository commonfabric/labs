/**
 * A list of records in place, each with a time of the data model, and a
 * window of the three newest that a computation returns: with the list
 * longer than the window, every position of the window holds another
 * record after each addition.
 */
import {
  computed,
  FabricEpochNsec,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

interface Item {
  text: string;
  at: FabricEpochNsec;
}

const add = handler<
  { text: string; nsec: number },
  { items: Writable<Item[]> }
>(
  (event, { items }) => {
    items.push({
      text: event.text,
      at: new FabricEpochNsec(BigInt(event.nsec)),
    });
  },
);

export const Windowed = pattern<
  Record<string, never>,
  { latest: Item[]; add: Stream<{ text: string; nsec: number }> }
>(() => {
  const items = new Writable<Item[]>([]);
  const latest = computed(() => items.get().slice(-3));
  return { latest, add: add({ items }) };
});
