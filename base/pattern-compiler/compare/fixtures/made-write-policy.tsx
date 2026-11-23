/// <cts-enable />
import {
  handler,
  pattern,
  type Stream,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

// An instance a pattern body makes, whose argument type names the handler
// `record` as the only writer of `note`. The outer pattern hands the
// instance a cell of its own, exposes the instance's stream, and has a
// handler of its own that writes the same cell, typed with no claim.

const record = handler<{ text: string }, { note: Writable<string> }>(
  (event, { note }) => {
    note.set(event.text);
  },
);

type Note = WriteAuthorizedBy<string, typeof record>;

interface InnerInput {
  note: Writable<Note>;
}

interface InnerOutput {
  note: Note;
  record: Stream<{ text: string }>;
}

const Inner = pattern<InnerInput, InnerOutput>(({ note }) => ({
  note,
  record: record({ note }),
}));

const forge = handler<{ text: string }, { note: Writable<string> }>(
  (event, { note }) => {
    note.set(event.text);
  },
);

interface Output {
  note: string;
  record: Stream<{ text: string }>;
  forge: Stream<{ text: string }>;
}

export default pattern<Record<string, never>, Output>(() => {
  const note = new Writable<Note>("");
  const inner = Inner({ note });
  return { note: inner.note, record: inner.record, forge: forge({ note }) };
});
