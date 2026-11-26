/// <cts-enable />
import {
  type Default,
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

// Writes the same field and is not the handler the policy names.
const overwrite = handler<{ text: string }, { note: Writable<string> }>(
  (event, { note }) => {
    note.set(event.text);
  },
);

/** A note that the handler `record` alone may write. */
export type Note = WriteAuthorizedBy<string, typeof record>;

// An argument field under a write policy that names one handler, with a
// default, and a plain field beside it. The pattern binds that handler and
// a second handler to the protected field.
export default pattern<
  { note?: Default<Note, "">; title?: Default<string, "untitled"> },
  {
    note: string;
    title: string;
    record: Stream<{ text: string }>;
    overwrite: Stream<{ text: string }>;
  }
>(({ note, title }) => ({
  note,
  title,
  record: record({ note }),
  overwrite: overwrite({ note }),
}));
