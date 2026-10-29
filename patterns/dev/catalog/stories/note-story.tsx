import { NAME, pattern, UI, type VNode } from "commonfabric";

import Note from "../../../system/notes/note.tsx";

// deno-lint-ignore no-empty-interface
interface NoteStoryInput {}
export interface NoteStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<NoteStoryInput, NoteStoryOutput>(() => {
  const note = Note({
    title: "Sample Note",
    content:
      "This is an **example** note with some content.\n\n- Item one\n- Item two\n- Item three",
  });

  return {
    [NAME]: "Note Story",
    [UI]: (
      <div style={{ height: "100%" }}>
        {note}
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. This story renders the Note pattern.
      </div>
    ),
  };
});
