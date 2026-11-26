/// <cts-enable />
import { handler, lift, pattern, Writable } from "commonfabric";

interface Item {
  id: string;
}

const find = lift((
  { items, wanted }: { items: Item[]; wanted: string },
): Item | undefined => items.find((item) => item.id === wanted));

// The handler tests whether `card` is present and reads a member of it:
// its body has an entry at `card` and one at `card.id`.
const note = handler<
  unknown,
  { card: Item | undefined; log: Writable<string[]> }
>((_, state) => {
  if (!state.card) {
    state.log.push("none");
    return;
  }
  state.log.push(state.card.id);
});

// A state path of a binding that is bound to a computed value, which is
// nothing where no item has the wanted id.
export default pattern<{ items: Item[]; wanted: string }>(
  ({ items, wanted }) => {
    const log = Writable.of<string[]>([]);
    const card = find({ items, wanted });
    return { log, note: note({ card, log }) };
  },
);
