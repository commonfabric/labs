/// <cts-enable />
import {
  computed,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

interface Item {
  title: string;
}

// An event that names an item by its position and gives it another title.
const rename = handler<
  { at: number; title: string },
  { items: Writable<Item[]> }
>((event, { items }) => {
  items.key(event.at).key("title").set(event.title);
});

// An event that adds an item at the end.
const add = handler<{ title: string }, { items: Writable<Item[]> }>(
  (event, { items }) => {
    items.push({ title: event.title });
  },
);

const call = handler<{ name: string }, { nickname: Writable<string> }>(
  (event, { nickname }) => {
    nickname.set(event.name);
  },
);

interface Row {
  title: string;
  marks: string[];
}

interface Output {
  rows: Row[];
  rename: Stream<{ at: number; title: string }>;
  add: Stream<{ title: string }>;
  call: Stream<{ name: string }>;
}

// A `map` over an array of references whose rows each hold a `map` over a
// value of the scope `user`, as each message row of FabriChat holds its
// reactions: the marks of a row are an array generated from scratch by a
// body that is not promoted, and hold the acting user's nickname.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const nickname = new Writable.perUser<string>("");
  return {
    rows: items.map((item) => {
      const marks = computed(() => {
        const out: string[] = [item.title];
        const name = nickname.get();
        if (name !== "") out.push(name);
        return out;
      });
      return { title: item.title, marks: marks.map((mark) => mark + "!") };
    }),
    rename: rename({ items }),
    add: add({ items }),
    call: call({ nickname }),
  };
});
