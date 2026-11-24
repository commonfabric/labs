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

// `scoped-view.tsx` with the value of the scope `user` computed by an
// authored `computed` whose block body is not promoted, read in the
// condition of a branch and placed as an attribute.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const nickname = new Writable.perUser<string>("");
  const named = computed(() => {
    let count = 0;
    for (const letter of nickname.get()) {
      if (letter !== " ") count += 1;
    }
    return count > 0;
  });
  return {
    [UI]: (
      <div>
        {named ? <b>{nickname}</b> : <i>nobody</i>}
        <cf-button disabled={!named}>Start</cf-button>
        {items.map((item) => <b>{item.title + "!"}</b>)}
      </div>
    ),
    rename: rename({ items }),
    call: call({ nickname }),
  };
});
