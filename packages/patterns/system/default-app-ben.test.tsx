import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import Note from "../notes/note.tsx";
import DefaultAppBen, {
  menuDailyJournal,
  removePiece,
} from "./default-app-ben.tsx";

type AddPieceStream = { send: (event: { piece: unknown }) => void };

export default pattern(() => {
  const subject = DefaultAppBen();
  const note = Note({ title: "Registered Note", content: "" });
  const otherNote = Note({ title: "Other Note", content: "" });
  const menuOpen = new Writable(false);

  const action_register_pieces = action(() => {
    const addPiece = subject.addPiece as AddPieceStream;
    addPiece.send({ piece: note });
    addPiece.send({ piece: otherNote });
  });
  const action_open_daily_journal = menuDailyJournal({
    menuOpen,
    pieceRegistry: subject.pieceRegistry,
  });
  const action_remove_piece = removePiece({
    piece: note,
    pieceRegistry: subject.pieceRegistry,
  });

  const assert_starts_empty = assert(() => subject.pieceRegistry.length === 0);
  const assert_add_piece_registers_both = assert(() =>
    subject.pieceRegistry.length === 2
  );
  const assert_daily_journal_keeps_registry = assert(() =>
    subject.pieceRegistry.length === 2
  );
  const assert_remove_piece_updates_registry = assert(() =>
    subject.pieceRegistry.length === 1
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },
      { action: action_register_pieces },
      { assertion: assert_add_piece_registers_both },
      { action: action_open_daily_journal },
      { assertion: assert_daily_journal_keeps_registry },
      { action: action_remove_piece },
      { assertion: assert_remove_piece_updates_registry },
    ],
    subject,
  };
});
