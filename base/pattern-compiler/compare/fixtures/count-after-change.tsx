/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

const addWord = handler<{ word: string }, { words: Writable<string[]> }>(
  (event, { words }) => {
    words.push(event.word);
  },
);

const addIfNoted = handler<
  unknown,
  { note: string; words: Writable<string[]> }
>(
  (_, { note, words }) => {
    if (note === "n") words.push("noted");
  },
);

const dropNote = handler<unknown, { note: string; words: Writable<string[]> }>(
  (_, { note, words }) => {
    words.removeByValue(note);
  },
);

// The number of members of a list of plain values in place, after an
// addition and a removal that the input `note` decides: `addIfNoted` adds
// a word where `note` holds one text, and `dropNote` removes the words that
// equal `note`.
export default pattern<{ note: string }>(({ note }) => {
  const words = Writable.of<string[]>([]);
  return {
    count: words.length,
    addWord: addWord({ words }),
    addIfNoted: addIfNoted({ note, words }),
    dropNote: dropNote({ note, words }),
  };
});
