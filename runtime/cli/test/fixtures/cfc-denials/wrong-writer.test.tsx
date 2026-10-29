/**
 * Fixture: a handler writes a field whose policy names a different handler as
 * its writer, so CFC refuses the commit.
 */

import {
  assert,
  handler,
  pattern,
  TESTS,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";

interface Note {
  text?: WriteAuthorizedBy<string, typeof approve>;
}

const approve = handler<void, { note: Writable<Note> }>((_, { note }) => {
  note.key("text").set("approved");
});

const forge = handler<void, { note: Writable<Note> }>((_, { note }) => {
  note.key("text").set("forged");
});

export default pattern(() => {
  const note = new Writable<Note>({});
  return {
    [TESTS]: [
      { action: forge({ note }) },
      { assertion: assert(() => note.get().text === undefined) },
    ],
    runApprove: approve({ note }),
    // The refusal's own warnings.
    allowConsoleWarnings: true,
  };
});
