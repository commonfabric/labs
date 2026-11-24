/// <cts-enable />
import {
  handler,
  pattern,
  type Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

const record = handler<{ text: string }, { note: Writable<string> }>(
  (event, { note }) => {
    note.set(event.text);
  },
);

// Writes the same cell and is not the handler the policy names.
const overwrite = handler<{ text: string }, { note: Writable<string> }>(
  (event, { note }) => {
    note.set(event.text);
  },
);

/** A note that the handler `record` alone may write. */
export type Note = WriteAuthorizedBy<string, typeof record>;

// A state cell under a write policy that names one handler, with that
// handler and a second handler that writes the same cell.
export default pattern<
  Record<string, never>,
  {
    note: Note;
    record: Stream<{ text: string }>;
    overwrite: Stream<{ text: string }>;
  }
>(() => {
  const note = new Writable<Note>("");
  return {
    note,
    record: record({ note }),
    overwrite: overwrite({ note }),
  };
});
