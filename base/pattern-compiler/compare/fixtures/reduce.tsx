/// <cts-enable />
import { pattern } from "commonfabric";

interface Item {
  title: string;
  amount: number;
}

interface Input {
  items: Item[];
  amounts: number[];
  bonus: number;
}

// A `reduce` in the reactive tier (PL §3.13): the runtime evaluates the
// step once per element, in order, with the accumulator as a slot of
// root `operation`. `total` is over records, which a test gives as
// references to cells, `weighted` over plain values stored in place, with
// the index, and `doubled` over the result of another per-element
// construct, with an input as its initial value. No step reads an outer
// input: the compiler of today's runtime refuses that in the callback of a
// `reduce`, and the fixture is compared with today's runtime.
export default pattern<Input>(({ items, amounts, bonus }) => {
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  const weighted = amounts.reduce(
    (sum, amount, index) => sum + amount * index,
    0,
  );
  const doubled = amounts
    .map((amount) => amount * 2)
    .reduce((sum, amount) => sum + amount, bonus);
  return { total, weighted, doubled };
});
