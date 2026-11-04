/**
 * Fixture: the same event as `policy-link-typed.test.tsx`, with the link's type
 * inferred as the stored note's, which names `add` as its only writer. The
 * test's own setup then has to satisfy that policy to store its steps.
 */

import { assert, pattern, TESTS, Writable } from "commonfabric";
import Notes, { ADD, type StoredNote, SURFACE } from "./policy-notes.tsx";

export default pattern(() => {
  const board = Notes({
    notes: Writable.of<StoredNote[]>([]),
    picked: Writable.of<string>(""),
  });

  return {
    [TESTS]: [
      {
        action: board.add,
        event: { text: "hello" },
        trustedUi: { surface: SURFACE, action: ADD },
      },
      { action: board.pick, event: { note: board.notes.key(0) } },
      { assertion: assert(() => board.picked === "hello") },
    ],
  };
});
