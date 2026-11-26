/// <cts-enable />
import { handler, pattern, type Stream, Writable } from "commonfabric";

// An event whose payload a user typed, consumed by a handler that writes it
// into a list of the space (the case of the owner's concept Z100: typing
// something into a space means sharing with it).

const post = handler<{ text: string }, { notes: Writable<string[]> }>(
  (event, { notes }) => {
    notes.push(event.text);
  },
);

interface Output {
  notes: string[];
  post: Stream<{ text: string }>;
}

export default pattern<{ notes: Writable<string[]> }, Output>(({ notes }) => ({
  notes,
  post: post({ notes }),
}));
