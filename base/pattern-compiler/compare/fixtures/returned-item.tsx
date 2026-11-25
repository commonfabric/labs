/// <cts-enable />
import { handler, pattern, type Stream, Writable } from "commonfabric";

type Title = string;

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
// state cell a handler writes. The type declares no clause, so a compiled
// start that reads it is not refused (note 1079).
export default pattern<Record<string, never>, Output>(() => {
  const title = Writable.of<Title>("");
  return { title, name: name({ title }) };
});
