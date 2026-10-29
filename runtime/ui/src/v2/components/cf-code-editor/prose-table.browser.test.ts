/** Browser checks for prose table colors, columns, and editable source. */

import { assert, assertEquals } from "@std/assert";

import { CFCodeEditor } from "./index.ts";

const MARKDOWN = [
  "# Lunch",
  "",
  "| Place | Food | Notes |",
  "| --- | --- | --- |",
  "| Cheeseboard | Pizza | Bring a blanket |",
].join("\n");

for (
  const [mode, text, surface] of [
    ["light", "rgb(25, 25, 25)", "rgb(240, 240, 240)"],
    ["dark", "rgb(245, 245, 247)", "rgb(45, 45, 48)"],
  ]
) {
  Deno.test(`prose table uses ${mode} theme colors`, async () => {
    const editor = new CFCodeEditor();
    editor.mode = "prose";
    editor.value = MARKDOWN;
    editor.style.cssText = `width: 600px; color: ${text};
      --cf-theme-color-text: ${text};
      --cf-theme-color-surface: ${surface};`;
    document.body.append(editor);
    try {
      await editor.updateComplete;
      const header = editor.shadowRoot!.querySelector(".cm-prose-table-header");
      assert(header);
      assertEquals(getComputedStyle(header).color, text);
      assertEquals(getComputedStyle(header).backgroundColor, surface);
    } finally {
      editor.remove();
    }
  });
}

Deno.test("prose table aligns columns and reveals source for editing", async () => {
  const editor = new CFCodeEditor();
  editor.mode = "prose";
  editor.value = MARKDOWN;
  editor.style.width = "600px";
  document.body.append(editor);
  try {
    await editor.updateComplete;
    const rows = editor.shadowRoot!.querySelectorAll(".cm-prose-table-row");
    assertEquals(rows.length, 2);
    const columns: number[][] = [];
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll(".cm-prose-table-cell"));
      assertEquals(cells.length, 3);
      const boxes = cells.map((cell) => cell.getBoundingClientRect());
      assertEquals(new Set(boxes.map((box) => Math.round(box.top))).size, 1);
      assert(boxes.every((box) => box.width > 0));
      columns.push(boxes.map((box) => Math.round(box.left)));
    }
    assertEquals(columns[0], columns[1]);
    const view = editor.editorView!;
    view.dispatch({ selection: { anchor: MARKDOWN.indexOf("Place") } });
    view.focus();
    // Focus changes the table's source decorations on the editor's frame.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve())
    );
    assertEquals(
      editor.shadowRoot!.querySelectorAll(".cm-prose-table-row").length,
      0,
    );
    assertEquals(view.state.doc.toString(), MARKDOWN);
  } finally {
    editor.remove();
  }
});
