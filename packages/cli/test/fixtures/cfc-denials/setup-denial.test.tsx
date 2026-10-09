/**
 * Fixture: the pattern supplies a value for an argument field of a pattern it
 * composes, and the field's policy names a handler as its only writer, so CFC
 * denies the setup commit and the run fails on the warning that denial logs.
 */

import {
  handler,
  pattern,
  TESTS,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

const approve = handler<void, { value: Writable<string> }>((_, { value }) => {
  value.set("approved");
});

interface NoteInput {
  note: Writable<WriteAuthorizedBy<string, typeof approve>>;
}

const Note = pattern<NoteInput>(({ note }) => ({
  runApprove: approve({ value: note }),
}));

export default pattern(() => {
  const note = Note({ note: "supplied" });
  return { [TESTS]: [], note };
});
