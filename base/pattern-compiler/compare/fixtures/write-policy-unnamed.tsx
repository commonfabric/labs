/// <cts-enable />
import {
  action,
  handler,
  pattern,
  type Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

// Writers that are not the handler a claim names, by where each is
// declared: `stamp` is declared at a `const` of module scope and a claim
// of another cell names it, `plain` is declared there and no claim names
// it, and `act` is an `action` of the pattern's body. Each writes `note`,
// which names `record` as its only writer. A handler written where it is
// bound is not among them: today's transformer refuses one inside a
// pattern.

const record = handler<{ text: string }, { note: Writable<string> }>(
  (event, { note }) => {
    note.set(event.text);
  },
);

const stamp = handler<
  { text: string },
  { note: Writable<string>; mark: Writable<string> }
>((event, { note, mark }) => {
  if (event.text === "mark") mark.set(event.text);
  else note.set(event.text);
});

const plain = handler<{ text: string }, { note: Writable<string> }>(
  (event, { note }) => {
    note.set(event.text);
  },
);

type Note = WriteAuthorizedBy<string, typeof record>;
type Mark = WriteAuthorizedBy<string, typeof stamp>;

interface Output {
  note: Note;
  mark: Mark;
  record: Stream<{ text: string }>;
  stamp: Stream<{ text: string }>;
  plain: Stream<{ text: string }>;
  act: Stream<void>;
}

export default pattern<Record<string, never>, Output>(() => {
  const note = new Writable<Note>("");
  const mark = new Writable<Mark>("");
  return {
    note,
    mark,
    record: record({ note }),
    stamp: stamp({ note, mark }),
    plain: plain({ note }),
    act: action(() => {
      note.set("by an action");
    }),
  };
});
