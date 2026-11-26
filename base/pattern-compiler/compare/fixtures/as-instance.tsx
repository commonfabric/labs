/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

interface Item {
  title: string;
}

const note = handler<{ text: string }, { noted: Writable<string> }>(
  (event, { noted }) => {
    noted.set(event.text);
  },
);

const Row = pattern<{ item: Item }>(({ item }) => {
  const noted = Writable.of("");
  return { title: item.title, noted, note: note({ noted }) };
});

const Word = pattern<{ tag: string }>(({ tag }) => {
  const noted = Writable.of("");
  return { tag, noted, note: note({ noted }) };
});

// Rulings Z35 and Z36: a pattern called through the factory modifier
// `asInstance()` in an element body is an instance of its own, with an
// argument document and a result document, identified by the site, the
// collection and the element key. It is not torn down when its key
// leaves, it is the same instance when the key returns, and an event for
// one of its streams is handled while the key is away. `rows` is over
// records, which a test gives as references to cells and as plain values
// in place. `words` is over plain values in place. `kept` is over the
// result of a `filter`. `plain` calls the same pattern with no modifier:
// it is compiled in, and an event for a stream of a row whose key left
// is refused. `lead` is a call through the modifier outside every element
// body: the same record, with no element key (assumed in
// `language-subset.md` §13, question 42). `asInstance()` is no member of
// today's `commonfabric`, so
// the executor's tests run this fixture and it is not compared with
// today's runtime.
export default pattern<{ items: Item[]; tags: string[]; lead: Item }>(
  ({ items, tags, lead }) => {
    return {
      rows: items.map((item) => Row.asInstance()({ item })),
      words: tags.map((tag) => Word.asInstance()({ tag })),
      kept: items.filter((item) => item.title !== "skip").map((item) =>
        Row.asInstance()({ item })
      ),
      plain: items.map((item) => Row({ item })),
      lead: Row.asInstance()({ item: lead }),
    };
  },
);
