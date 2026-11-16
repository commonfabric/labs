/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

// A handler that draws from `Math.random`: a number, and the order of a
// list. The comparison seeds the generator before each event on both
// sides (`compare/random.ts`), so today's run and the executor's draw
// the same numbers.
const draw = handler<
  unknown,
  { drawn: Writable<number>; order: Writable<string[]> }
>((_, { drawn, order }) => {
  drawn.set(Math.floor(Math.random() * 1000000));
  const all = [...order.get()];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  order.set(all);
});

export default pattern<{ note: string }>(({ note }) => {
  const drawn = Writable.of(0);
  const order = Writable.of<string[]>(["a", "b", "c", "d", "e", "f", "g"]);
  return { note, drawn, order, draw: draw({ drawn, order }) };
});
