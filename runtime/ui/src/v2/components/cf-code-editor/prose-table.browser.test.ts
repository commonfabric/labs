/** Browser checks for prose table colors, columns, and editable source. */

import { assert, assertEquals } from "@std/assert";

import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { CFCodeEditor } from "./index.ts";
import { test } from "@commonfabric/test-support/test";

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
  test(`prose table uses ${mode} theme colors`, async () => {
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

test("prose table draws formulas and line breaks inside their cells", async () => {
  const markdown = [
    "| Rule | Certification |",
    "| --- | --- |",
    "| $a$ | $\\underline{x}$ := $\\underline{y}$ |",
    "| mid $b$ mid | first<br>second |",
  ].join("\n");
  const editor = new CFCodeEditor();
  editor.mode = "prose";
  editor.math = true;
  editor.value = markdown;
  editor.style.width = "600px";
  document.body.append(editor);
  try {
    await editor.updateComplete;
    const root = editor.shadowRoot!;
    const formulas = Array.from(root.querySelectorAll(".cm-prose-math"));
    assertEquals(
      formulas.map((formula) =>
        formula.querySelector("annotation")?.textContent
      ),
      ["a", "\\underline{x}", "\\underline{y}", "b"],
    );
    for (const formula of formulas) {
      assert(formula.closest(".cm-prose-table-cell"));
      assert(formula.getBoundingClientRect().width > 0);
    }
    const cell = root.querySelector(".cm-prose-br")?.closest(
      ".cm-prose-table-cell",
    );
    assert(cell);
    // The top of the text node in `cell` that reads `text`.
    const top = (text: string) => {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.textContent !== text) continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        return range.getBoundingClientRect().top;
      }
      throw new Error(`No text "${text}" in the cell.`);
    };
    assert(top("second") > top("first"));
  } finally {
    editor.remove();
  }
});

test("prose table aligns columns and reveals source for editing", async () => {
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
    // CodeMirror reports focus in an update a timer sets off after the focus
    // event, and the table's source decorations follow in that update, so
    // the test waits for it rather than for any length of time.
    const focused = Promise.withResolvers<void>();
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          if (update.focusChanged && update.view.hasFocus) focused.resolve();
        }),
      ),
    });
    view.dispatch({ selection: { anchor: MARKDOWN.indexOf("Place") } });
    view.focus();
    await focused.promise;
    assertEquals(
      editor.shadowRoot!.querySelectorAll(".cm-prose-table-row").length,
      0,
    );
    assertEquals(view.state.doc.toString(), MARKDOWN);
  } finally {
    editor.remove();
  }
});
