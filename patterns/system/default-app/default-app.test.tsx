/**
 * Test: registering a piece is idempotent by identity.
 *
 * addPiece dedups with addUnique on the piece cell rather than a
 * read-then-push guard. That only works because the event field is declared
 * as a cell: a plain-typed event would arrive as a query-result proxy, which
 * addUnique compares by deep equality against the stored link and never
 * matches — every registration would append a duplicate and nothing would
 * report it. These tests pin the two halves: re-sending the same piece cell
 * leaves one entry, and distinct pieces still land.
 *
 * Run: deno task cf test patterns/system/default-app/default-app.test.tsx --root patterns --verbose
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElementByExactText,
  propsOf,
} from "../../tools/test-support/vnode-helpers.ts";
import DefaultApp from "./default-app.tsx";
import Note from "../notes/note.tsx";

type AddPieceStream = { send: (event: { piece: unknown }) => void };

// Module scope: SES callbacks may not capture callables from enclosing
// function scopes.
const addPieceOf = (subject: Record<string, unknown>, piece: unknown) =>
  (subject.addPiece as AddPieceStream).send({ piece });

const piecesLengthOf = (subject: Record<string, unknown>) =>
  [...((subject.pieceRegistry as unknown[]) ?? [])].length;

const clickFirstRemove = (subject: { [UI]: unknown }) => {
  const button = findElementByExactText(subject[UI], "cf-button", "🗑️");
  const onClick = propsOf(button)?.onClick;
  (onClick as { send: (event: Record<string, never>) => void }).send({});
};

export default pattern(() => {
  const subject = DefaultApp();

  const note = Note({
    title: "Registered Note",
    content: "",
  });
  const otherNote = Note({
    title: "Other Note",
    content: "",
  });

  const action_register_note = action(() => addPieceOf(subject, note));
  const action_register_note_again = action(() => addPieceOf(subject, note));
  const action_register_other_note = action(() =>
    addPieceOf(subject, otherNote)
  );
  const action_remove_first_note = action(() => clickFirstRemove(subject));

  const assert_starts_empty = assert(() => piecesLengthOf(subject) === 0);

  const assert_first_registration_lands = assert(() =>
    piecesLengthOf(subject) === 1
  );

  // The same piece cell again must resolve to the same membership entry.
  const assert_duplicate_registration_is_noop = assert(() =>
    piecesLengthOf(subject) === 1
  );

  // Dedup is by identity, not a cap: a distinct piece still lands.
  const assert_distinct_piece_lands = assert(() =>
    piecesLengthOf(subject) === 2
  );
  const assert_remove_updates_registry = assert(() =>
    piecesLengthOf(subject) === 1
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },

      { action: action_register_note },
      { assertion: assert_first_registration_lands },

      { action: action_register_note_again },
      { assertion: assert_duplicate_registration_is_noop },

      { action: action_register_other_note },
      { assertion: assert_distinct_piece_lands },

      { action: action_remove_first_note },
      { assertion: assert_remove_updates_registry },
    ],
    subject,
  };
});
