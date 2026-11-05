import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElementByExactText,
  findElementByText,
  propsOf,
} from "../../tools/test-support/vnode-helpers.ts";
import Note from "../../system/notes/note.tsx";
import DefaultAppBen from "./default-app-ben.tsx";

type AddPieceStream = { send: (event: { piece: unknown }) => void };
type ClickStream = { send: (event: Record<string, never>) => void };

const click = (node: unknown) => {
  (propsOf(node)?.onClick as ClickStream).send({});
};

export default pattern(() => {
  const subject = DefaultAppBen();
  const note = Note({ title: "Registered Note", content: "" });
  const otherNote = Note({ title: "Other Note", content: "" });

  const action_register_pieces = action(() => {
    const addPiece = subject.addPiece as AddPieceStream;
    addPiece.send({ piece: note });
    addPiece.send({ piece: otherNote });
  });
  const action_open_daily_journal = action(() => {
    click(findElementByText(subject[UI], "cf-button", "Daily Journal"));
  });
  const action_remove_piece = action(() => {
    click(findElementByExactText(subject[UI], "cf-button", "🗑️"));
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
