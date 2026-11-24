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
  rename: Stream<{ at: number; title: string }>;
  call: Stream<{ name: string }>;
}

// `scoped-view.tsx` with the value of the scope `user` read in the body of
// the `map` over an array of references as well: each row says whether the
// acting user has a nickname, so the rows are of the scope `user`.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const nickname = new Writable.perUser<string>("");
  const named = computed(() => nickname.get().length > 0);
  return {
    [UI]: (
      <div>
        {named ? <b>{nickname}</b> : <i>nobody</i>}
        <cf-button disabled={!named}>Start</cf-button>
        {items.map((item) => <b>{named ? item.title + "!" : item.title}</b>)}
      </div>
    ),
    rename: rename({ items }),
    call: call({ nickname }),
  };
});
