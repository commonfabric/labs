/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

const fill = handler<unknown, { extra: string; words: Writable<string[]> }>(
  (_, { extra, words }) => {
    words.set([extra, `${extra}!`]);
  },
);

const add = handler<{ word: string }, { words: Writable<string[]> }>(
  (event, { words }) => {
    words.push(event.word);
  },
);

// A list of plain values in place that is an input, so its document
// declares a label at its root. `fill` writes the whole list from the input
// `extra`, and `add` appends a word of its event: the members `fill` wrote
// stand where they stood, and what they hold still depends on `extra`.
export default pattern<{ extra: string; words: Writable<string[]> }>(
  ({ extra, words }) => ({
    words,
    fill: fill({ extra, words }),
    add: add({ words }),
  }),
);
