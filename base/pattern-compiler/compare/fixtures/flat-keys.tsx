/// <cts-enable />
import { pattern } from "commonfabric";

interface Group {
  name: string;
  members: string[];
}

interface Input {
  groups: Group[];
  words: string[];
}

// The keys of the result of a `flatMap` (PL §1.3, assumed there under
// question 101): the key of the element a segment came from, with the
// position in the segment. `names` is over records, which a test gives
// as references to cells, and each segment is an array the element
// holds. `halves` is over plain values stored in place, and each segment
// is an array the callback writes. The second `map` of each is over the
// result of the `flatMap`, so its cone instances have those keys.
export default pattern<Input>(({ groups, words }) => {
  const names = groups.flatMap((group) => group.members);
  const loudNames = names.map((name) => name + "!");
  const halves = words.flatMap((word) => [word + "1", word + "2"]);
  const loudHalves = halves.map((half) => half + "!");
  return { names, loudNames, halves, loudHalves };
});
