/**
 * Checks where a mounted editor's margin puts its children: beside the text
 * at the anchors they name while the margin is beside the text, and in their
 * order once it wraps below it. Where text is drawn is for the browser's
 * layout to say, so the tests run in one. The tests register through
 * `Deno.test`, as `deno-web-test` requires.
 */

import { expect } from "@std/expect";
import type { EditorView } from "@codemirror/view";
import type { FieldAnchors } from "@commonfabric/runtime-client";

import { CFCodeEditor } from "../index.ts";
import { setHighlightAnchorsEffect } from "./highlights.ts";

/** Twenty lines, `line 1` to `line 20`. */
const TEXT = Array.from({ length: 20 }, (_, at) => `line ${at + 1}`).join(
  "\n",
);

/** The offset where line `number` of {@link TEXT} starts. */
const lineStart = (number: number): number =>
  TEXT.split("\n").slice(0, number - 1).join("\n").length +
  (number > 1 ? 1 : 0);

/** A block of `height` pixels, naming `anchor` where one is given. */
function block(height: number, anchor?: string): HTMLElement {
  const element = document.createElement("div");
  element.style.height = `${height}px`;
  if (anchor !== undefined) element.setAttribute("data-anchor", anchor);
  return element;
}

/**
 * Mounts an editor `width` wide holding {@link TEXT}, with `children` and
 * the field's `anchors`.
 */
async function mount(
  width: string,
  children: HTMLElement[],
  anchors: FieldAnchors,
): Promise<{ editor: CFCodeEditor; view: EditorView }> {
  const editor = new CFCodeEditor();
  editor.value = TEXT;
  editor.style.width = width;
  editor.append(...children);
  document.body.append(editor);
  await editor.updateComplete;
  const view = editor.editorView;
  if (view === undefined) throw new Error("The editor view is missing.");
  view.dispatch({ effects: setHighlightAnchorsEffect.of(anchors) });
  return { editor, view };
}

/**
 * Resolves once `holds` returns `true`, checking now and after each change
 * to the `style` of `editor` or anything in it.
 */
function until(editor: CFCodeEditor, holds: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (holds()) return resolve();
    const observer = new MutationObserver(() => {
      if (!holds()) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(editor, {
      attributes: true,
      subtree: true,
      attributeFilter: ["style"],
    });
  });
}

/** Whether `element` is drawn level with the text at `offset`. */
const levelWith = (
  view: EditorView,
  element: HTMLElement,
  offset: number,
): boolean => {
  const text = view.coordsAtPos(offset, 1);
  return text !== null &&
    Math.abs(element.getBoundingClientRect().top - text.top) < 1;
};

Deno.test("the margin moves a child naming an anchor beside the text there, and the child after it with it", async () => {
  // The child naming `late` comes first in the document and its anchor
  // comes later in the text, so the two anchored children change places.

  const late = block(30, "late");
  const follower = block(10);
  const early = block(30, "early");
  const { editor, view } = await mount(
    "900px",
    [block(20), late, follower, early],
    { early: lineStart(5), late: lineStart(12) },
  );
  try {
    await until(
      editor,
      () =>
        levelWith(view, early, lineStart(5)) &&
        levelWith(view, late, lineStart(12)),
    );

    expect(
      Math.round(
        follower.getBoundingClientRect().top -
          late.getBoundingClientRect().bottom,
      ),
    ).toBe(8);
  } finally {
    editor.remove();
  }
});

Deno.test("the margin leaves its children unmoved, in their order, once it wraps below the text", async () => {
  const late = block(30, "late");
  const early = block(30, "early");
  const { editor, view } = await mount("900px", [late, early], {
    early: lineStart(5),
    late: lineStart(12),
  });
  try {
    await until(editor, () => levelWith(view, early, lineStart(5)));

    editor.style.width = "300px";
    await until(
      editor,
      () => late.style.translate === "" && early.style.translate === "",
    );

    expect(
      Math.round(
        early.getBoundingClientRect().top - late.getBoundingClientRect().bottom,
      ),
    ).toBe(8);
    expect(late.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      view.dom.getBoundingClientRect().bottom,
    );
  } finally {
    editor.remove();
  }
});
