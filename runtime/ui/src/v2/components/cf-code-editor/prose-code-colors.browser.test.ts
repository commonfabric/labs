/**
 * Checks that a prose editor draws code and quotes in the colors of the theme
 * around it, so a code block on a dark surface is dark rather than a light
 * slab under light text. Computed colors need a laid-out editor, so these run
 * in a browser.
 */

import { assert } from "@std/assert";

import { CFThemeProvider } from "../cf-theme/index.ts";
import { CFCodeEditor } from "./index.ts";

const DOCUMENT = [
  "Meeting notes",
  "",
  "Run `deno task check` first.",
  "",
  "```",
  "const answer = 42;",
  "```",
  "",
  "> Ship it on Friday.",
].join("\n");

/** A prose editor showing `DOCUMENT` inside a `<cf-theme>` of `colorScheme`. */
async function mount(colorScheme: "light" | "dark") {
  const provider = new CFThemeProvider();
  provider.theme = { colorScheme };
  const editor = new CFCodeEditor();
  editor.mode = "prose";
  editor.value = DOCUMENT;
  provider.append(editor);
  document.body.append(provider);
  await provider.updateComplete;
  await editor.updateComplete;
  return { editor, done: () => provider.remove() };
}

/** The computed `property` of the first `selector` in the editor. */
function drawn(
  editor: CFCodeEditor,
  selector: string,
  property: "backgroundColor" | "color" | "borderLeftColor",
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

for (const scheme of ["light", "dark"] as const) {
  const light = scheme === "light";

  Deno.test(`a prose editor in a ${scheme} theme draws code backgrounds ${scheme}`, async () => {
    const { editor, done } = await mount(scheme);
    try {
      for (const selector of [".cm-prose-codeblock", ".cm-prose-inline-code"]) {
        const background = drawn(editor, selector, "backgroundColor");
        assert(
          isLight(background) === light,
          `${selector} is ${scheme}, not ${background}`,
        );
      }
    } finally {
      done();
    }
  });

  Deno.test(`a prose editor in a ${scheme} theme draws quote ink readable on its surface`, async () => {
    const { editor, done } = await mount(scheme);
    try {
      const ink = drawn(editor, ".cm-prose-blockquote", "color");
      assert(isLight(ink) !== light, `the quote ink is legible, not ${ink}`);
    } finally {
      done();
    }
  });
}
