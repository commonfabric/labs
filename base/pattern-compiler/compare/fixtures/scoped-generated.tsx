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
  owner?: Writable<string>;
}

// An event that names an item by its position and makes the acting user's
// nickname its owner: the item then holds a link to a state cell of the
// scope `user`.
const claim = handler<
  { at: number },
  { items: Writable<Item[]>; nickname: Writable<string> }
>((event, { items, nickname }) => {
  items.key(event.at).key("owner").set(nickname);
});

const call = handler<{ name: string }, { nickname: Writable<string> }>(
  (event, { nickname }) => {
    nickname.set(event.name);
  },
);

// An event of a row that keeps a reference to the row's element, a
// position of the document that holds the array, in a state cell of the
// space.
const pick = handler<
  void,
  { owner: Writable<string>; picked: Writable<string | undefined> }
>((_event, { owner, picked }) => {
  picked.set(owner);
});

interface Output {
  [UI]: VNode;
  claim: Stream<{ at: number }>;
  call: Stream<{ name: string }>;
}

// A `computed` over an array of references whose block body is not
// promoted, with a `map` over its result in the rendered tree. The body
// reads nothing of a user until an item holds a link to the nickname, a
// state cell of the scope `user`; from then on it reads through that link
// and is of the scope `user`. The rendered tree reads nothing of a user.
export default pattern<{ items: Writable<Item[]> }, Output>(({ items }) => {
  const nickname = new Writable.perUser<string>("");
  const picked = new Writable<string | undefined>(undefined);
  const owners = computed(() => {
    const out: string[] = [];
    for (const item of items) {
      out.push(item.owner === undefined ? "nobody" : `${item.owner}`);
    }
    return out;
  });
  return {
    [UI]: (
      <div>
        {owners.map((owner) => (
          <b onClick={pick({ owner, picked })}>{owner}</b>
        ))}
        <i>{picked}</i>
      </div>
    ),
    claim: claim({ items, nickname }),
    call: call({ nickname }),
  };
});
