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
  item: string;
  shown: string;
}

interface Output {
  rows: Row[];
  rename: Stream<{ at: number; title: string }>;
  add: Stream<{ title: string }>;
  call: Stream<{ name: string }>;
}

// A `map` over an array of plain values in place whose rows are records,
// one member of which reads whether the acting session has a nickname, a
// value of the scope `session`.
export default pattern<{ items: Writable<string[]> }, Output>(({ items }) => {
  const nickname = new Writable.perSession<string>("");
  const named = computed(() => nickname.get().length > 0);
  return {
    rows: items.map((item) => ({ item, shown: named ? item + "!" : item })),
    rename: rename({ items }),
    add: add({ items }),
    call: call({ nickname }),
  };
});
