/// <cts-enable />
import {
  type Confidential,
  type CurrentPrincipal,
  handler,
  pattern,
  type Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

/** Readable only by the user whose transaction creates the store. */
type OnlyMe<T> = Confidential<
  T,
  readonly [{
    type: "https://commonfabric.org/cfc/atom/User";
    subject: CurrentPrincipal;
  }]
>;

const record = handler<{ text: string }, { note: Writable<OnlyMe<string>> }>(
  (event, { note }) => {
    note.set(event.text);
  },
);

// Writes the same cell and is not the handler the policy names.
const overwrite = handler<
  { text: string },
  { note: Writable<OnlyMe<string>> }
>((event, { note }) => {
  note.set(event.text);
});

/** A note of its creator's that the handler `record` alone may write. */
export type Note = OnlyMe<WriteAuthorizedBy<string, typeof record>>;

// A state cell that its type declares readable by the principal who
// creates it, under a write policy that names one handler, with that
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
