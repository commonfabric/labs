/// <cts-enable />

/**
 * Alice's handler writes a field whose policy names a different handler as its
 * writer, so CFC refuses the commit. She allows console warnings, which is
 * where a refusal is reported on either arm: a denial, not a runtime error.
 */

import {
  assert,
  handler,
  multiUserTest,
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

export interface RefusalSetup {
  note: Writable<Note>;
}

export const setup = pattern<Record<string, never>, RefusalSetup>(() => ({
  note: new Writable<Note>({}),
}));

export const alice = pattern<{ setup: RefusalSetup }>(({ setup }) => ({
  [TESTS]: [
    { action: forge({ note: setup.note }) },
    { assertion: assert(() => setup.note.get().text === undefined) },
  ],
  runApprove: approve({ note: setup.note }),
  allowConsoleWarnings: true,
}));

export default multiUserTest({ setup, participants: { alice } });
