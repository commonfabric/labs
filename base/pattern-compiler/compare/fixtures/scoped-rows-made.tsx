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

// An event that adds an item at the end, in a document of its own.
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

interface Output {
  [UI]: VNode;
  add: Stream<{ title: string }>;
  call: Stream<{ name: string }>;
}

// The rows of a `map` over an array of references, each with a handler of
// its own and a value that reads whether the acting session has a
// nickname, a value of the scope `session`. Each item an event adds is a
// document the piece made.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const nickname = new Writable.perSession<string>("");
  const named = computed(() => nickname.get().length > 0);
  return {
    [UI]: (
      <div>
        {items.map((item) => (
          <cf-button onClick={() => items.push({ title: "again" })}>
            {named ? item.title + "!" : item.title}
          </cf-button>
        ))}
      </div>
    ),
    add: add({ items }),
    call: call({ nickname }),
  };
});
