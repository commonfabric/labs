/** Checks that unfinished headings preserve a mounted editor's prose rendering. */

import { assert, assertEquals } from "@std/assert";

import { CFCodeEditor } from "./index.ts";

for (const marker of ["#", "# "]) {
  Deno.test(`prose formatting survives a remote unfinished ${JSON.stringify(marker)} heading`, async () => {
    const editor = new CFCodeEditor();
    editor.mode = "prose";
    editor.value = "# Agenda\n\nMeeting notes";
    document.body.append(editor);
    try {
      await editor.updateComplete;
      const view = editor.editorView;
      assert(view);
      assertEquals(
        editor.shadowRoot!.querySelectorAll(".cm-prose-h1").length,
        1,
      );
      // Remote text arrives without moving this reader's selection to it.
      view.dispatch({
        changes: { from: view.state.doc.length, insert: `\n\n${marker}` },
      });
      assertEquals(
        editor.shadowRoot!.querySelectorAll(".cm-prose-h1").length,
        1,
      );
      view.dispatch({
        changes: {
          from: view.state.doc.length,
          insert: `${marker.endsWith(" ") ? "" : " "}Comms`,
        },
      });
      assertEquals(
        editor.shadowRoot!.querySelectorAll(".cm-prose-h1").length,
        2,
      );
      assertEquals(
        view.state.doc.toString(),
        "# Agenda\n\nMeeting notes\n\n# Comms",
      );
    } finally {
      editor.remove();
    }
  });
}
