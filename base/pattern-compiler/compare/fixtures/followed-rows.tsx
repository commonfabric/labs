/// <cts-enable />
import {
  computed,
  handler,
  pattern,
  SELF,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

interface Owner {
  name: string;
}

interface Item {
  title: string;
  owner?: Writable<Owner>;
}

interface Note {
  title: string;
}

interface Facts {
  count: number;
  marks: Record<string, string>;
}

// What every row looks up, from one walk over the notes and the items
// through their handles: the notes are read through every element, and each
// item's title by its position.
const factsOf = (
  items: Writable<Item[]>,
  notes: Writable<Note[]>,
): Facts => {
  const marks: Record<string, string> = {};
  for (const note of notes.get()) marks[note.title] = "noted";
  const count = items.get().length;
  for (let index = 0; index < count; index++) {
    const title = items.key(index).key("title").get();
    if (marks[title] === undefined) marks[title] = "listed";
  }
  return { count, marks };
};

// An event that adds an item linking to the owner, and keeps the result of
// the instance where it is there, as a room tells its manager it was
// joined.
const add = handler<
  { title: string },
  {
    items: Writable<Item[]>;
    owner: Writable<Owner>;
    self?: Writable<{ count: number }>;
    kept: Writable<unknown>;
  }
>((event, { items, owner, self, kept }) => {
  items.push({ title: event.title, owner });
  if (self === undefined) return;
  kept.set(self);
});

interface Output {
  [UI]: VNode;
  count: number;
  add: Stream<{ title: string }>;
}

// A result whose tree holds the rows of a `map` over `items`, an array of
// references, each row following its item's link to the owner, another
// document, and looking up what the facts say of its title.
export default pattern<
  { items: Writable<Item[]>; notes: Writable<Note[]>; owner: Writable<Owner> },
  Output
>(({ items, notes, owner, [SELF]: self }) => {
  const facts = computed(() => factsOf(items, notes));
  const kept = Writable.of<unknown>(null);
  return {
    [UI]: (
      <ul>
        {items.map((item) => (
          <li>
            <b>{item.title}</b>
            <i>{computed(() => item.owner?.get()?.name ?? "")}</i>
            <span>{facts.marks[item.title] ?? ""}</span>
          </li>
        ))}
      </ul>
    ),
    count: facts.count,
    add: add({ items, owner, self, kept }),
  };
});
