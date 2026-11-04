import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import type { MentionablePiece } from "../backlinks-index/backlinks-index.tsx";
import { createNotebookHandler, createNoteHandler } from "./quick-capture.tsx";

export default pattern(() => {
  const pieceRegistry = new Writable<MentionablePiece[]>([]);
  const createNote = createNoteHandler({ pieceRegistry });
  const createNotebook = createNotebookHandler({ pieceRegistry });

  const action_create_note = action(() => {
    createNote.send({
      title: "Captured thought",
      content: "A useful detail",
    });
  });
  const action_create_notebook = action(() => {
    createNotebook.send({
      title: "Capture Log",
      notes: [{ title: "Transcript", content: "Raw input" }],
    });
  });

  const assert_note_is_registered = assert(() =>
    pieceRegistry.get().length === 1 && pieceRegistry.get()[0] !== undefined
  );
  const assert_notebook_is_registered = assert(() =>
    pieceRegistry.get().length === 2 && pieceRegistry.get()[1] !== undefined
  );

  return {
    [TESTS]: [
      { action: action_create_note },
      { assertion: assert_note_is_registered },
      { action: action_create_notebook },
      { assertion: assert_notebook_is_registered },
    ],
  };
});
