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
  hidden: boolean;
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

interface Rights {
  canEdit: boolean;
  label: string;
}

interface Output {
  rows: ({ title: string } & Rights)[];
  rename: Stream<{ at: number; title: string }>;
  call: Stream<{ name: string }>;
}

// A `map` over the result of a `filter` over an array of references, whose
// rows spread what the acting session may do, a value of the scope
// `session`, into the record each returns.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const nickname = new Writable.perSession<string>("");
  const named = computed(() => nickname.get().length > 0);
  return {
    rows: items
      .filter((item) => !item.hidden)
      .map((item) => ({
        title: item.title,
        ...(named
          ? { canEdit: true, label: item.title + "!" }
          : { canEdit: false, label: item.title + "?" }),
      })),
    rename: rename({ items }),
    call: call({ nickname }),
  };
});
