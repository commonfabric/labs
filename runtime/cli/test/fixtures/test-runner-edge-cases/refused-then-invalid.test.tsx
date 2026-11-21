/// <cts-enable />

/**
 * Fixture: a handler writes a field whose policy names a different handler as
 * its writer, so CFC refuses the commit, and the next step carries no
 * discriminant, so the run ends in an error with the refusal on record.
 */

import {
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
      // deno-lint-ignore no-explicit-any
      { notAValidStep: true } as any,
    ],
    runApprove: approve({ note }),
    allowConsoleWarnings: true,
  };
});
