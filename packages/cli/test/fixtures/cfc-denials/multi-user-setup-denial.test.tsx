/// <cts-enable />

/**
 * Fixture: a multi-user run in which one participant's own pattern supplies a
 * value for an argument field of a pattern it composes, and the field's policy
 * names a handler as its only writer, so CFC denies that participant's setup
 * commit and the run fails on the warning it logs.
 */

import {
  handler,
  multiUserTest,
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

export const setup = pattern<Record<string, never>>(() => ({}));

export const alice = pattern(() => {
  const note = Note({ note: "supplied" });
  return { [TESTS]: [], note };
});

export default multiUserTest({ setup, participants: { alice } });
