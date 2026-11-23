/// <cts-enable />
import {
  computed,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

interface Item {
  id: string;
  title: string;
  done: boolean;
}

interface Row {
  label: string;
  done: boolean;
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
  rows: Row[];
  summary: string;
  rename: Stream<{ at: number; title: string }>;
  call: Stream<{ name: string }>;
}

// The list of `serving-list.tsx`, a `map` over an array that the type
// declares as references and that a test gives as an array of references,
// whose rows read nothing of a user, beside state of the scope `user` and
// a value derived from it.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const nickname = new Writable.perUser<string>("nobody");
  const rows = items.map((item) => ({
    label: item.title + "!",
    done: item.done,
  }));
  const summary = computed(() => `${nickname.get()} reads`);
  return {
    rows,
    summary,
    rename: rename({ items }),
    call: call({ nickname }),
  };
});
