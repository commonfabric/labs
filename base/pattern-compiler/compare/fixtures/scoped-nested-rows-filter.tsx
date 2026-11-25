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

// `scoped-nested-rows.tsx` with the `map` over the result of a `filter` over
// an array of references, as the main conversation of FabriChat is: each
// row holds a `map` over marks of the scope `user`.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const nickname = new Writable.perUser<string>("");
  return {
    rows: items.filter((item) => item.title !== "").map((item) => {
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
