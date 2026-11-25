/// <cts-enable />
import {
  computed,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

// An event that names an item by its position and gives it another title.
const rename = handler<
  { at: number; title: string },
  { items: Writable<string[]> }
>((event, { items }) => {
  items.key(event.at).set(event.title);
});

// An event that adds an item at the end.
const add = handler<{ title: string }, { items: Writable<string[]> }>(
  (event, { items }) => {
    items.push(event.title);
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

// `scoped-nested-rows.tsx` over an array of plain values in place: each row
// holds a `map` over marks of the scope `user`.
export default pattern<{ items: Writable<string[]> }, Output>(({ items }) => {
  const nickname = new Writable.perUser<string>("");
  return {
    rows: items.map((item) => {
      const marks = computed(() => {
        const out: string[] = [item];
        const name = nickname.get();
        if (name !== "") out.push(name);
        return out;
      });
      return { title: item, marks: marks.map((mark) => mark + "!") };
    }),
    rename: rename({ items }),
    add: add({ items }),
    call: call({ nickname }),
  };
});
