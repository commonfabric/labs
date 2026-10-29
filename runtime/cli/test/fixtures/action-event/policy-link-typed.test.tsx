/**
 * Fixture: a step's event carries a link to a stored note, held in a local
 * typed with the handler's event type, so the test's own steps name no write
 * policy.
 */

import { assert, type Cell, pattern, TESTS, Writable } from "commonfabric";
import Notes, {
  ADD,
  type NoteRecord,
  type StoredNote,
  SURFACE,
} from "./policy-notes.tsx";

export default pattern(() => {
  const board = Notes({
    notes: Writable.of<StoredNote[]>([]),
    picked: Writable.of<string>(""),
  });
  const first: Cell<NoteRecord> = board.notes.key(0);

  return {
    [TESTS]: [
      {
        action: board.add,
        event: { text: "hello" },
        trustedUi: { surface: SURFACE, action: ADD },
      },
      { action: board.pick, event: { note: first } },
      { assertion: assert(() => board.picked === "hello") },
    ],
  };
});
