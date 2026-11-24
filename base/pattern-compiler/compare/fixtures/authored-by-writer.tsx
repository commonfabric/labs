/// <cts-enable />
import {
  type AuthoredByCurrentUser,
  handler,
  pattern,
  type Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

// A list whose members are each authored by the current user and written
// by the handler `write` alone. The list is an array of plain values in
// place, and starts empty. The handlers declare the members as plain
// records, since a type that names a handler cannot be in the type of that
// handler: the claims of a member one appends are those the stored schema
// of the list declares.

interface Text {
  text: string;
}

const write = handler<{ text: string }, { notes: Writable<Text[]> }>(
  (event, { notes }) => {
    notes.push({ text: event.text });
  },
);

type Note = AuthoredByCurrentUser<WriteAuthorizedBy<Text, typeof write>>;

// A handler no claim names.
const forge = handler<{ text: string }, { notes: Writable<Text[]> }>(
  (event, { notes }) => {
    notes.push({ text: event.text });
  },
);

interface Output {
  notes: Note[];
  write: Stream<{ text: string }>;
  forge: Stream<{ text: string }>;
}

export default pattern<Record<string, never>, Output>(() => {
  const notes = Writable.of<Note[]>([]);
  return { notes, write: write({ notes }), forge: forge({ notes }) };
});
