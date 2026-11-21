/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

interface Card {
  suit: string;
  rank: number;
}

// Reads two arrays through their handles and writes each with members
// of the other: the last card of each pile goes to the other pile.
const swap = handler<
  unknown,
  { left: Writable<Card[]>; right: Writable<Card[]> }
>((_, { left, right }) => {
  const all = [...left.get(), ...right.get()];
  const at = left.get().length;
  left.set([...all.slice(0, at - 1), all[all.length - 1]]);
  right.set([...all.slice(at, -1), all[at - 1]]);
});

// Reads one element through a handle and writes it to a cell.
const keep = handler<
  unknown,
  { left: Writable<Card[]>; kept: Writable<Card | null> }
>((_, { left, kept }) => {
  kept.set(left.get()[0]);
});

// Finds the element of its row with a handle by position.
const discard = handler<
  unknown,
  { left: Writable<Card[]>; card: Writable<Card> }
>((_, { left, card }) => {
  const cards = left.get();
  const index = cards.findIndex((_card, at) => left.key(at).equals(card));
  if (index >= 0) left.set(cards.toSpliced(index, 1));
});

// Rulings Z25, Z26 and Z33 over arrays of plain values in place. A
// function body that reads a plain value through a handle holds a copy,
// and writing it elsewhere stores the value: `swap` moves cards between
// two arrays, and `keep` stores a card in a cell, which a later change
// of the pile does not change. `left.key(at)` is a handle by position,
// and it is equal to the reference by key of the row's element while
// that element is at the position: `discard` removes the card of its
// row.
export default pattern<{ left: Writable<Card[]>; right: Writable<Card[]> }>(
  ({ left, right }) => {
    const kept = Writable.of<Card | null>(null);
    return {
      left,
      right,
      kept,
      rows: left.map((card) => ({
        rank: card.rank,
        discard: discard({ left, card }),
      })),
      swap: swap({ left, right }),
      keep: keep({ left, kept }),
    };
  },
);
