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
 * Run: deno task cf test packages/patterns/system/default-app.test.tsx --root packages/patterns --verbose
 */
import {
  action,
  assert,
  computed,
  handler,
  pattern,
  type Stream,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { findElementByExactText, propsOf } from "../test/vnode-helpers.ts";
import DefaultApp from "./default-app.tsx";
import Note from "../notes/note.tsx";
import { type MentionablePiece } from "./backlinks-index.tsx";

const addPiece = handler<void, {
  stream: Stream<{ piece: Writable<MentionablePiece> }>;
  piece: Writable<MentionablePiece>;
}>((_, { stream, piece }) => stream.send({ piece }));

const piecesLengthOf = (pieceRegistry: unknown[]) => [...pieceRegistry].length;

export default pattern(() => {
  const subject = DefaultApp();
  const currentUI = computed(() => subject[UI]);

  const note = Note({
    title: "Registered Note",
    content: "",
  });
  const otherNote = Note({
    title: "Other Note",
    content: "",
  });

  const action_register_note = addPiece({
    stream: subject.addPiece,
    piece: note,
  });
  const action_register_note_again = addPiece({
    stream: subject.addPiece,
    piece: note,
  });
  const action_register_other_note = addPiece({
    stream: subject.addPiece,
    piece: otherNote,
  });
  const action_remove_first_note = action(() => {
    const button = findElementByExactText(currentUI, "cf-button", "🗑️");
    const onClick = propsOf(button)?.onClick;
    (onClick as { send: (event: Record<string, never>) => void }).send({});
  });

  const assert_starts_empty = assert(() =>
    piecesLengthOf(subject.pieceRegistry) === 0
  );

  const assert_first_registration_lands = assert(() =>
    piecesLengthOf(subject.pieceRegistry) === 1
  );

  // The same piece cell again must resolve to the same membership entry.
  const assert_duplicate_registration_is_noop = assert(() =>
    piecesLengthOf(subject.pieceRegistry) === 1
  );

  // Dedup is by identity, not a cap: a distinct piece still lands.
  const assert_distinct_piece_lands = assert(() =>
    piecesLengthOf(subject.pieceRegistry) === 2
  );
  const assert_remove_updates_registry = assert(() =>
    piecesLengthOf(subject.pieceRegistry) === 1
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
