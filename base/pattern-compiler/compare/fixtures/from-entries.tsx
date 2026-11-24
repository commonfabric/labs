/// <cts-enable />
import { lift, pattern } from "commonfabric";

interface Donut {
  name: string;
  price: number;
}

// FA §3.4: `Object.fromEntries` over an input reads which pairs the input
// holds and the key of each, and over pairs that the body built it reads
// the key of each pair. The count of the keys depends on both.
const keyCount = lift((pairs: [string, number][]) =>
  Object.keys(Object.fromEntries(pairs)).length
);
const nameCount = lift((donuts: Donut[]) =>
  Object.keys(
    Object.fromEntries(donuts.map((donut) => [donut.name, donut.price])),
  ).length
);

export default pattern<{ pairs: [string, number][]; donuts: Donut[] }>(
  ({ pairs, donuts }) => {
    return { keys: keyCount(pairs), names: nameCount(donuts) };
  },
);
