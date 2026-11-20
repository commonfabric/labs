/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

const setIfNoted = handler<
  unknown,
  { note: string; words: Writable<string[]> }
>(
  (_, { note, words }) => {
    words.set(note === "n" ? ["a", "b"] : []);
  },
);

const clearIfNoted = handler<
  unknown,
  { note: string; words: Writable<string[]> }
>(
  (_, { note, words }) => {
    words.set(note === "n" ? [] : ["a", "b"]);
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

const putAtEnd = handler<{ word: string }, { words: Writable<string[]> }>(
  (event, { words }) => {
    words.key(words.get().length).set(event.word);
  },
);

const putIfNoted = handler<
  { at: number },
  { note: string; words: Writable<string[]> }
>(
  (event, { note, words }) => {
    if (note === "n") words.key(event.at).set("noted");
  },
);

const addOnce = handler<{ word: string }, { words: Writable<string[]> }>(
  (event, { words }) => {
    words.addUnique(event.word);
  },
);

const bumpIfNoted = handler<
  unknown,
  { note: string; total: Writable<number> }
>(
  (_, { note, total }) => {
    if (note === "n") total.increment(1);
  },
);

const bump = handler<{ by: number }, { total: Writable<number> }>(
  (event, { total }) => {
    total.increment(event.by);
  },
);

const mark = handler<
  { key: string },
  { marks: Writable<Record<string, boolean>> }
>(
  (event, { marks }) => {
    marks.key(event.key).set(true);
  },
);

const markNote = handler<
  unknown,
  { note: string; marks: Writable<Record<string, boolean>> }
>(
  (_, { note, marks }) => {
    marks.update({ [note]: true });
  },
);

// The methods of a handle that change what a cell holds, each run after a
// write that the input `note` decides: a list set whole and then written
// by position, a list added to with `addUnique`, a number incremented, and
// a record given a key with `key().set()` and with `update()`.
export default pattern<{ note: string }>(({ note }) => {
  const words = Writable.of<string[]>([]);
  const total = Writable.of(0);
  const marks = Writable.of<Record<string, boolean>>({});
  return {
    words,
    count: words.length,
    shouted: words.map((word) => word.toUpperCase()),
    total,
    marks,
    setIfNoted: setIfNoted({ note, words }),
    putAt: putAt({ words }),
    putAtEnd: putAtEnd({ words }),
    addOnce: addOnce({ words }),
    putIfNoted: putIfNoted({ note, words }),
    bumpIfNoted: bumpIfNoted({ note, total }),
    bump: bump({ total }),
    mark: mark({ marks }),
    markNote: markNote({ note, marks }),
    clearIfNoted: clearIfNoted({ note, words }),
  };
});
