/**
 * Fixture: a note two handlers may write, each through its own reviewed
 * action on one surface, and nothing else may. The steps alternate the two
 * writers, then try each wrong pairing and a third handler, each of which CFC
 * refuses.
 */

import {
  assert,
  handler,
  pattern,
  TESTS,
  type TrustedActionWrite,
  Writable,
  type WritePolicyAnyOf,
} from "commonfabric";

const SURFACE = "NoteSurface";
const SEND = "SendNote";
const EDIT = "EditNote";

type Note = WritePolicyAnyOf<string, [
  TrustedActionWrite<unknown, typeof send, typeof SEND, typeof SURFACE>,
  TrustedActionWrite<unknown, typeof edit, typeof EDIT, typeof SURFACE>,
]>;

interface Board {
  note?: Note;
}

const send = handler<void, { board: Writable<Board> }>((_, { board }) => {
  board.key("note").set("sent");
});

const edit = handler<void, { board: Writable<Board> }>((_, { board }) => {
  board.key("note").set("edited");
});

const forge = handler<void, { board: Writable<Board> }>((_, { board }) => {
  board.key("note").set("forged");
});

const gesture = (action: string) => ({ surface: SURFACE, action });

export default pattern(() => {
  const board = new Writable<Board>({});
  const isSent = assert(() => board.get().note === "sent");
  const isEdited = assert(() => board.get().note === "edited");
  return {
    [TESTS]: [
      { action: send({ board }), trustedUi: gesture(SEND) },
      { assertion: isSent },
      { action: edit({ board }), trustedUi: gesture(EDIT) },
      { assertion: isEdited },
      { action: send({ board }), trustedUi: gesture(SEND) },
      { assertion: isSent },
      // Each writer through the other's action.
      { action: edit({ board }), trustedUi: gesture(SEND) },
      { assertion: isSent },
      { action: edit({ board }), trustedUi: gesture(EDIT) },
      { assertion: isEdited },
      { action: send({ board }), trustedUi: gesture(EDIT) },
      { assertion: isEdited },
      // A writer with no gesture, and a writer the policy does not name.
      { action: send({ board }) },
      { action: forge({ board }), trustedUi: gesture(SEND) },
      { assertion: isEdited },
    ],
    // The refusals' own warnings.
    allowConsoleWarnings: true,
  };
});
