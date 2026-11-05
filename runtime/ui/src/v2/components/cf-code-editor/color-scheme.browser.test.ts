/**
 * Checks that the editor draws what CodeMirror paints itself — the caret and
 * the selection — in the color scheme of the `<cf-theme>` around it.
 *
 * The editor's text and surface come from the `--cf-theme-*` tokens, which
 * follow the scheme on their own. The caret and selection come from
 * CodeMirror's base theme, which only knows the page is dark if the editor
 * tells it; when it did not, a dark page got a black caret on a dark surface.
 * Computed colors need a laid-out editor, so these run in a browser.
 */

import { assert, assertEquals } from "@std/assert";

import { CFThemeProvider } from "../cf-theme/index.ts";
import { CFCodeEditor } from "./index.ts";

interface Mounted {
  theme: CFThemeProvider;
  editor: CFCodeEditor;
  done(): void;
}

/** An editor in `mode` inside a `<cf-theme>` whose scheme is `colorScheme`. */
async function mount(
  colorScheme: "light" | "dark",
  mode: "code" | "prose",
  theme?: "dark",
): Promise<Mounted> {
  const provider = new CFThemeProvider();
  provider.theme = { colorScheme };
  const editor = new CFCodeEditor();
  editor.mode = mode;
  if (theme) editor.theme = theme;
  editor.value = "Meeting notes";
  provider.append(editor);
  document.body.append(provider);
  await provider.updateComplete;
  await editor.updateComplete;
  return { theme: provider, editor, done: () => provider.remove() };
}

/**
 * Selects the first word and resolves once CodeMirror has drawn the caret and
 * the selection for it.
 *
 * The drawn layers update in CodeMirror's measure cycle. The selection change
 * queues their measure first, so a measure requested after it writes last.
 */
function drawSelection(editor: CFCodeEditor): Promise<void> {
  const view = editor.editorView;
  assert(view, "the component builds an editor view");
  view.dispatch({ selection: { anchor: 0, head: "Meeting".length } });
  const drawn = Promise.withResolvers<void>();
  view.requestMeasure({ read: () => {}, write: () => drawn.resolve() });
  return drawn.promise;
}

/** The computed `property` of the first `selector` in the editor. */
function drawn(
  editor: CFCodeEditor,
  selector: string,
  property: "borderLeftColor" | "backgroundColor",
): string {
  const element = editor.shadowRoot?.querySelector(selector);
  assert(element instanceof HTMLElement, `the editor draws ${selector}`);
  return getComputedStyle(element)[property];
}

/** Whether an `rgb()`/`rgba()` color is closer to white than to black. */
function isLight(color: string): boolean {
  const channels = color.match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number);
  assert(channels?.length === 3, `${color} is an rgb color`);
  const [r, g, b] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 127.5;
}

for (const mode of ["code", "prose"] as const) {
  Deno.test(`a ${mode} editor in a dark theme draws a light caret and a dark selection`, async () => {
    const { editor, done } = await mount("dark", mode);
    try {
      await drawSelection(editor);
      const caret = drawn(editor, ".cm-cursor", "borderLeftColor");
      assert(isLight(caret), `the caret is light, not ${caret}`);
      const selection = drawn(
        editor,
        ".cm-selectionBackground",
        "backgroundColor",
      );
      assert(!isLight(selection), `the selection is dark, not ${selection}`);
    } finally {
      done();
    }
  });

  Deno.test(`a ${mode} editor in a light theme draws a dark caret and a light selection`, async () => {
    const { editor, done } = await mount("light", mode);
    try {
      await drawSelection(editor);
      const caret = drawn(editor, ".cm-cursor", "borderLeftColor");
      assert(!isLight(caret), `the caret is dark, not ${caret}`);
      const selection = drawn(
        editor,
        ".cm-selectionBackground",
        "backgroundColor",
      );
      assert(isLight(selection), `the selection is light, not ${selection}`);
    } finally {
      done();
    }
  });
}

Deno.test("the caret follows the theme when its scheme changes", async () => {
  const { theme, editor, done } = await mount("light", "prose");
  try {
    await drawSelection(editor);
    assert(!isLight(drawn(editor, ".cm-cursor", "borderLeftColor")));
    theme.theme = { colorScheme: "dark" };
    await theme.updateComplete;
    await editor.updateComplete;
    await drawSelection(editor);
    assert(isLight(drawn(editor, ".cm-cursor", "borderLeftColor")));
  } finally {
    done();
  }
});

Deno.test("an editor asking for theme dark keeps oneDark's caret in a light theme", async () => {
  const { editor, done } = await mount("light", "code", "dark");
  try {
    await drawSelection(editor);
    // oneDark's cursor color, #528bff.
    assertEquals(
      drawn(editor, ".cm-cursor", "borderLeftColor"),
      "rgb(82, 139, 255)",
    );
  } finally {
    done();
  }
});

Deno.test("an editor with no theme around it draws the light base the tokens fall back to", async () => {
  // A page-wide dark preference is what an "auto" scheme would follow; with
  // no <cf-theme> the tokens are their light fallbacks, so the base stays light.
  document.documentElement.setAttribute("data-theme", "dark");
  const editor = new CFCodeEditor();
  editor.value = "Meeting notes";
  document.body.append(editor);
  try {
    await editor.updateComplete;
    await drawSelection(editor);
    const caret = drawn(editor, ".cm-cursor", "borderLeftColor");
    assert(!isLight(caret), `the caret is dark, not ${caret}`);
  } finally {
    editor.remove();
    document.documentElement.removeAttribute("data-theme");
  }
});
