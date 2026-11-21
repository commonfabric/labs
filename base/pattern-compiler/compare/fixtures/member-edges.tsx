/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

const add = handler<{ word: string }, { words: Writable<string[]> }>(
  (event, { words }) => {
    words.push(event.word);
  },
);

const addSecret = handler<
  unknown,
  { secret: string; words: Writable<string[]> }
>(
  (_, { secret, words }) => {
    words.push(secret);
  },
);

const dropFirstAndAdd = handler<
  { word: string },
  { words: Writable<string[]> }
>(
  (event, { words }) => {
    words.removeByValue(words.get()[0]);
    words.push(event.word);
  },
);

const clearAtIfNoted = handler<
  { at: number },
  { note: string; words: Writable<(string | undefined)[]> }
>(
  (event, { note, words }) => {
    if (note === "n") words.key(event.at).set(undefined);
  },
);

const putAt = handler<
  { at: number; word: string },
  { words: Writable<string[]> }
>(
  (event, { words }) => {
    words.key(event.at).set(event.word);
  },
);

// Changes of the members of a list of plain values in place at its edges:
// a removal and an addition in one transaction, which leaves a member at
// the position another stood at; a position set to `undefined`; and a
// write at a position beyond the last member.
export default pattern<{ note: string; secret: string }>(
  ({ note, secret }) => {
    const words = Writable.of<string[]>([]);
    return {
      words,
      count: words.length,
      add: add({ words }),
      addSecret: addSecret({ secret, words }),
      dropFirstAndAdd: dropFirstAndAdd({ words }),
      clearAtIfNoted: clearAtIfNoted({ note, words }),
      putAt: putAt({ words }),
    };
  },
);
