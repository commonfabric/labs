/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

const addNote = handler<unknown, { note: string; words: Writable<string[]> }>(
  (_, { note, words }) => {
    words.push(note);
  },
);

const addWord = handler<{ word: string }, { words: Writable<string[]> }>(
  (event, { words }) => {
    words.push(event.word);
  },
);

const drop = handler<{ word: string }, { words: Writable<string[]> }>(
  (event, { words }) => {
    words.removeByValue(event.word);
  },
);

// A removal from a list of plain values in place: `drop` removes a word a
// handler pushed from its event, and the word `addNote` pushed from the
// input `note` then stands at the position before its own. The removal
// reads the list and writes back what it keeps.
export default pattern<{ note: string }>(({ note }) => {
  const words = Writable.of<string[]>([]);
  return {
    words,
    addNote: addNote({ note, words }),
    addWord: addWord({ words }),
    drop: drop({ words }),
  };
});
