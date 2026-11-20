/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

const addBoth = handler<
  { word: string },
  { note: string; words: Writable<string[]> }
>(
  (event, { note, words }) => {
    if (note === "n") words.push("noted");
    words.push(event.word);
  },
);

// Two additions of one handler to a list of plain values in place: the
// first under a condition on the input `note`, the second under none. The
// write edge of the handler has one template, over everything the body
// reads, so the record of each addition holds the label of `note`.
export default pattern<{ note: string }>(({ note }) => {
  const words = Writable.of<string[]>([]);
  return {
    words,
    count: words.length,
    addBoth: addBoth({ note, words }),
  };
});
