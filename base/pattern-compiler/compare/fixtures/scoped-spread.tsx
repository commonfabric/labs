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

const call = handler<{ name: string }, { nickname: Writable<string> }>(
  (event, { nickname }) => {
    nickname.set(event.name);
  },
);

interface Output {
  named: boolean;
  rows: string[];
  rename: Stream<{ at: number; title: string }>;
  call: Stream<{ name: string }>;
}

// A result that spreads a record the body builds, which holds whether the
// acting session has a nickname, a value of the scope `session`, beside the
// rows of a `map` over an array of references, as FabriChat's room spreads
// its view.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const nickname = new Writable.perSession<string>("");
  const named = computed(() => nickname.get().length > 0);
  const view = { named, rows: items.map((item) => item.title) };
  return { ...view, rename: rename({ items }), call: call({ nickname }) };
});
