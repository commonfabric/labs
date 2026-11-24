/// <cts-enable />
import {
  computed,
  handler,
  pattern,
  type Stream,
  UI,
  type VNode,
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
  [UI]: VNode;
  named: boolean;
  rename: Stream<{ at: number; title: string }>;
  call: Stream<{ name: string }>;
}

// The rows of a `map` over an array of references, each of which reads
// whether the acting session has a nickname, a value of the scope
// `session`, beside an output of the result that is that value itself,
// which is stored in the scope instances of the document of the scoped
// outputs.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const nickname = new Writable.perSession<string>("");
  const named = computed(() => nickname.get().length > 0);
  return {
    [UI]: (
      <div>
        {items.map((item) => <b>{named ? item.title + "!" : item.title}</b>)}
      </div>
    ),
    named,
    rename: rename({ items }),
    call: call({ nickname }),
  };
});
