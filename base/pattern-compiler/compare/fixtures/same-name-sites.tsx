/// <cts-enable />
import { computed, handler, pattern, UI, Writable } from "commonfabric";

const bump = handler<unknown, { count: Writable<number> }>((_, { count }) => {
  count.set(count.get() + 1);
});

// A callee with a state cell, a handler that writes it, and a plain array
// generated from scratch that a `map` of the callee iterates: the array
// has a document of its own, named by the output.
const Counter = pattern<{ label: string; words: string[] }>(
  ({ label, words }) => {
    const count = Writable.of(0);
    const loud = computed(() => words.map((word) => word.toUpperCase()));
    return {
      [UI]: (
        <button type="button" onClick={bump({ count })}>
          {label}: {count}
          {loud.map((word) => <i>{word}</i>)}
        </button>
      ),
      count,
    };
  },
);

// Three tags of one pattern in one body: three call sites of one name
// (PL §1.3), each with a state cell, a stream and an array of its own.
export default pattern<{ title: string; first: string[]; second: string[] }>(
  ({ title, first, second }) => {
    return {
      [UI]: (
        <div>
          <Counter label="a" words={first} />
          <Counter label="b" words={second} />
          <Counter label={title} words={first} />
        </div>
      ),
    };
  },
);
