/**
 * Checks that a mounted prose editor with `math` draws formulas with KaTeX,
 * and that one without it leaves them as text.
 */

import { assert, assertEquals } from "@std/assert";

import { CFCodeEditor } from "./index.ts";

const NOTE = "Euler: $e^{i\\pi} + 1 = 0$, for $5.\n\n" +
  "$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\n" +
  "Bad: $\\frac{1$ and $\\href{https://example.com}{link}$.";

/** The TeX of each inline formula KaTeX drew under `root`, in order. */
function inlineFormulas(root: ShadowRoot): (string | null)[] {
  return Array.from(
    root.querySelectorAll(".cm-prose-math annotation"),
    (annotation) => annotation.textContent,
  );
}

/** Mounts a prose editor holding `NOTE`, runs `check`, and unmounts it. */
async function withEditor(
  math: boolean,
  check: (root: ShadowRoot, editor: CFCodeEditor) => Promise<void> | void,
): Promise<void> {
  const editor = new CFCodeEditor();
  editor.mode = "prose";
  editor.math = math;
  editor.value = NOTE;
  document.body.append(editor);
  try {
    await editor.updateComplete;
    assert(editor.editorView);
    await check(editor.shadowRoot!, editor);
  } finally {
    editor.remove();
  }
}

Deno.test("a prose editor with math draws inline and block formulas with KaTeX", async () => {
  await withEditor(true, (root) => {
    assertEquals(inlineFormulas(root), [
      "e^{i\\pi} + 1 = 0",
      "\\href{https://example.com}{link}",
    ]);
    assert(root.querySelector(".cm-prose-math-block .katex-display"));
    assertEquals(
      root.querySelector(".cm-prose-math-block annotation")?.textContent,
      "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
    );
    assert(root.querySelector(".cm-prose-math .katex-html [style]"));
  });
});

Deno.test("a prose editor with math shows TeX KaTeX cannot parse as written", async () => {
  await withEditor(true, (root) => {
    const error = root.querySelector<HTMLElement>(".cm-prose-math-error");
    assertEquals(error?.textContent, "$\\frac{1$");
    assert(error?.title.includes("KaTeX parse error"));
  });
});

Deno.test("a prose editor with math draws no link a formula asks for", async () => {
  await withEditor(true, (root) => {
    assertEquals(root.querySelectorAll(".cm-content a").length, 0);
  });
});

Deno.test("a prose editor with math keeps a $$ formula inside a sentence in its line", async () => {
  const editor = new CFCodeEditor();
  editor.mode = "prose";
  editor.math = true;
  editor.value = "So $$x = 1$$ holds.";
  document.body.append(editor);
  try {
    await editor.updateComplete;
    const display = editor.shadowRoot!.querySelector(
      ".cm-prose-math .katex-display",
    );
    assert(display);
    assertEquals(getComputedStyle(display).display, "inline-block");
  } finally {
    editor.remove();
  }
});

Deno.test("a prose editor with math sets a quoted formula without the quote's markers", async () => {
  const editor = new CFCodeEditor();
  editor.mode = "prose";
  editor.math = true;
  editor.value = "> $$\n> x^2\n> $$\n\nAfter.\n\n> - $$\n>   a > b\n>   $$";
  document.body.append(editor);
  try {
    await editor.updateComplete;
    assertEquals(inlineFormulas(editor.shadowRoot!), ["x^2", "a > b"]);
  } finally {
    editor.remove();
  }
});

Deno.test("a prose editor without math leaves formulas as text", async () => {
  await withEditor(false, (root, editor) => {
    assertEquals(root.querySelectorAll(".katex").length, 0);
    assert(editor.editorView!.contentDOM.textContent?.includes("$e^{i\\pi}"));
  });
});

Deno.test("math set on a focused editor shows the TeX of the formula under the cursor", async () => {
  await withEditor(false, async (root, editor) => {
    const view = editor.editorView!;
    view.focus();
    view.dispatch({
      selection: { anchor: view.state.doc.toString().indexOf("e^{") },
    });
    assert(view.hasFocus);
    editor.math = true;
    await editor.updateComplete;
    assertEquals(
      root.querySelector(".cm-prose-math-source")?.textContent,
      "$e^{i\\pi} + 1 = 0$",
    );
    assertEquals(inlineFormulas(root), ["\\href{https://example.com}{link}"]);
  });
});

Deno.test("focus followed at once by another update still shows the TeX under the cursor", async () => {
  await withEditor(true, async (root, editor) => {
    const view = editor.editorView!;
    const formula = view.state.doc.toString().indexOf("e^{");
    view.focus();
    // Two updates in a row, as the editor's own listeners make: CodeMirror's
    // focus transaction, queued by the first, is dropped by the second.
    view.dispatch({ selection: { anchor: 0 } });
    view.dispatch({ selection: { anchor: formula } });
    assert(view.hasFocus);
    // The correction goes out in a microtask queued by those updates, which
    // runs before this continuation.
    await Promise.resolve();
    assertEquals(
      root.querySelector(".cm-prose-math-source")?.textContent,
      "$e^{i\\pi} + 1 = 0$",
    );
  });
});

Deno.test("setting math on a mounted prose editor starts drawing formulas", async () => {
  await withEditor(false, async (root, editor) => {
    editor.math = true;
    await editor.updateComplete;
    assertEquals(inlineFormulas(root)[0], "e^{i\\pi} + 1 = 0");
  });
});
