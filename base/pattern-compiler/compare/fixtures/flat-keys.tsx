/// <cts-enable />
import { pattern } from "commonfabric";

interface Person {
  name: string;
}

interface Group {
  name: string;
  members: string[];
  people: Person[];
}

interface Input {
  groups: Group[];
  words: string[];
  flip: boolean;
}

// The keys of the result of a `flatMap` (PL §1.3, "The key of an element
// that a `flatMap` contributes"; ruling Z22): the key of the element a
// segment came from, together with a part formed from the member itself,
// which is the identity of the cell for a member that is a reference and
// the value for a member that is a plain value, with the count of the
// earlier equal members of the same segment. `names` and `people` are
// over records, which a test gives as references to cells, and each
// segment is an array the element holds: of plain values in `names`, and
// in `people` of records, which a test gives as references. `halves` is
// over plain values stored in place, and each segment is an array of
// plain values that the callback writes, in an order `flip` chooses. The
// second `map` of each is over the result of the `flatMap`, so its cone
// instances have those keys.
export default pattern<Input>(({ groups, words, flip }) => {
  const names = groups.flatMap((group) => group.members);
  const loudNames = names.map((name) => name + "!");
  const people = groups.flatMap((group) => group.people);
  const loudPeople = people.map((person) => person.name + "!");
  const halves = words.flatMap((word) =>
    flip ? [word + "2", word + "1"] : [word + "1", word + "2"]
  );
  const loudHalves = halves.map((half) => half + "!");
  return { names, loudNames, people, loudPeople, halves, loudHalves };
});
