/// <cts-enable />
import {
  type AuthoredByCurrentUser,
  computed,
  type Default,
  handler,
  pattern,
  type Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

// A list of the argument whose members are each authored by the current
// user and written by the handler `write` alone, as a FabriChat room
// declares its messages, and which the argument a client writes leaves out,
// so the first append of the handler makes it. The list is an array of
// plain values in place.

interface Text {
  text: string;
}

const write = handler<{ text: string }, { notes: Writable<Text[]> }>(
  (event, { notes }) => {
    notes.push({ text: event.text });
  },
);

type Note = AuthoredByCurrentUser<WriteAuthorizedBy<Text, typeof write>>;

interface Output {
  count: number;
  write: Stream<{ text: string }>;
}

export default pattern<
  { notes: Writable<Note[] | Default<[]>> },
  Output
>(({ notes }) => ({
  count: computed(() => notes.get().length),
  write: write({ notes }),
}));
