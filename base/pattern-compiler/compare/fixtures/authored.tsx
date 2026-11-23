/// <cts-enable />
import {
  type AuthoredByCurrentUser,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

// A handler whose write needs the integrity of the acting principal: each
// element of the list is declared as authored by the current user, so the
// commit of the handler that appends one mints the claim for the principal
// the run acts for, and is refused for a run that acts for no one. The
// list is an array of plain values in place, and starts empty, so the
// start of the piece writes no value that the claim is about.

type Note = AuthoredByCurrentUser<{ text: string }>;

const write = handler<{ text: string }, { notes: Writable<Note[]> }>(
  (event, { notes }) => {
    notes.push({ text: event.text });
  },
);

interface Output {
  notes: Note[];
  write: Stream<{ text: string }>;
}

export default pattern<Record<string, never>, Output>(() => {
  const notes = Writable.of<Note[]>([]);
  return { notes, write: write({ notes }) };
});
