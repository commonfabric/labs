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

// An event that names an item by its position and gives it another title.
const rename = handler<
  { at: number; title: string },
  { items: Writable<string[]> }
>((event, { items }) => {
  items.key(event.at).set(event.title);
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

// `scoped-view.tsx` over an array of plain values in place: the rows of
// the `map` read nothing of a user.
export default pattern<{ items: Writable<string[]> }, Output>(({ items }) => {
  const nickname = new Writable.perUser<string>("");
  const named = computed(() => nickname.get().length > 0);
  return {
    [UI]: (
      <div>
        {named ? <b>{nickname}</b> : <i>nobody</i>}
        <cf-button disabled={!named}>Start</cf-button>
        {items.map((item) => <b>{item + "!"}</b>)}
      </div>
    ),
    rename: rename({ items }),
    call: call({ nickname }),
  };
});
