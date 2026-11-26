/// <cts-enable />
import { Default, handler, pattern, Writable } from "commonfabric";

interface Entry {
  text: string;
}

const addTag = handler<{ text: string }, { tags: Writable<string[]> }>(
  (event, { tags }) => {
    tags.push(event.text);
  },
);

const addEntry = handler<{ text: string }, { entries: Writable<Entry[]> }>(
  (event, { entries }) => {
    entries.push({ text: event.text });
  },
);

interface Input {
  tags: Writable<Default<string[], ["first"]>>;
  entries: Writable<Default<Entry[], [{ text: "given" }]>>;
}

// Ruling Z27: a `push` through a handle to a path of the argument that
// holds nothing, and whose schema declares a default, starts from the
// default, as a write below the root of a state cell does. `tags` is an
// array of plain values in place. The record of the default of `entries`
// is a plain value in place, and the record that is pushed is a
// reference.
export default pattern<Input>(({ tags, entries }) => {
  return {
    tags,
    entries,
    addTag: addTag({ tags }),
    addEntry: addEntry({ entries }),
  };
});
