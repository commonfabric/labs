/// <cts-enable />
import {
  type Confidential,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

type Title = Confidential<string, readonly ["item-title"]>;

const name = handler<{ title: string }, { title: Writable<Title> }>(
  (event, { title }) => {
    title.set(event.title);
  },
);

interface Output {
  title: Title;
  name: Stream<{ title: string }>;
}

// An item that is a document of its own: the result holds its title, a
// state cell whose type declares the clause `item-title`, which a handler
// writes.
export default pattern<Record<string, never>, Output>(() => {
  const title = Writable.of<Title>("");
  return { title, name: name({ title }) };
});
