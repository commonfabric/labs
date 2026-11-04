/**
 * Native DOM checks for `cf-keybind`'s `ignore-editable`. Editors such as
 * `cf-code-editor` and `cf-input` keep their editable element in a shadow
 * root, and a keydown that crosses that boundary reaches the document with
 * the shadow host as its target. These dispatch real composed events from
 * inside real shadow roots.
 */

import { expect } from "@std/expect";
import type { LitElement } from "lit";
import type { CFKeybind } from "./index.ts";
// The entrypoints register cf-keybind and cf-input in the browser.
import "./index.ts";
import "../cf-input/index.ts";

/** A connected `cf-keybind` for ArrowRight that counts its matches. */
function arrowRightBinding() {
  const binding = document.createElement("cf-keybind") as CFKeybind;
  binding.code = "ArrowRight";
  let fired = 0;
  binding.addEventListener("cf-keybind", () => fired++);
  document.body.append(binding);
  return {
    binding,
    fired: () => fired,
    dispose: () => binding.remove(),
  };
}

/**
 * A host with an open shadow root holding `inner`, nested one shadow root
 * deeper still, the way a component that wraps an editor component would.
 */
function nestedInShadow(inner: HTMLElement) {
  const outer = document.createElement("div");
  const middle = document.createElement("div");
  outer.attachShadow({ mode: "open" }).append(middle);
  middle.attachShadow({ mode: "open" }).append(inner);
  document.body.append(outer);
  return { dispose: () => outer.remove() };
}

function pressArrowRight(target: EventTarget) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      code: "ArrowRight",
      key: "ArrowRight",
      bubbles: true,
      composed: true,
    }),
  );
}

function editableInShadow(kind: string): HTMLElement {
  if (kind === "contenteditable") {
    const div = document.createElement("div");
    div.contentEditable = "true";
    return div;
  }
  return document.createElement(kind);
}

for (const kind of ["contenteditable", "input", "textarea", "select"]) {
  Deno.test(`cf-keybind ignores a key typed into a ${kind} inside shadow roots`, () => {
    const view = arrowRightBinding();
    const editable = editableInShadow(kind);
    const tree = nestedInShadow(editable);
    try {
      pressArrowRight(editable);
      expect(view.fired()).toBe(0);
    } finally {
      tree.dispose();
      view.dispose();
    }
  });
}

Deno.test("cf-keybind fires for a key on a non-editable element inside shadow roots", () => {
  const view = arrowRightBinding();
  const plain = document.createElement("div");
  const tree = nestedInShadow(plain);
  try {
    pressArrowRight(plain);
    expect(view.fired()).toBe(1);
  } finally {
    tree.dispose();
    view.dispose();
  }
});

Deno.test("cf-keybind fires for a key on a plain element in the document", () => {
  const view = arrowRightBinding();
  const plain = document.createElement("div");
  document.body.append(plain);
  try {
    pressArrowRight(plain);
    expect(view.fired()).toBe(1);
  } finally {
    plain.remove();
    view.dispose();
  }
});

Deno.test("cf-keybind ignores a key typed into an input in the document", () => {
  const view = arrowRightBinding();
  const input = document.createElement("input");
  document.body.append(input);
  try {
    pressArrowRight(input);
    expect(view.fired()).toBe(0);
  } finally {
    input.remove();
    view.dispose();
  }
});

Deno.test("cf-keybind with ignore-editable off fires inside a shadow-rooted editor", () => {
  const view = arrowRightBinding();
  view.binding.ignoreEditable = false;
  const editable = editableInShadow("contenteditable");
  const tree = nestedInShadow(editable);
  try {
    pressArrowRight(editable);
    expect(view.fired()).toBe(1);
  } finally {
    tree.dispose();
    view.dispose();
  }
});

Deno.test("cf-keybind ignores a key typed into a cf-input", async () => {
  const view = arrowRightBinding();
  const field = document.createElement("cf-input") as LitElement;
  document.body.append(field);
  try {
    await field.updateComplete;
    const input = field.shadowRoot?.querySelector("input");
    if (!input) throw new Error("cf-input rendered no input.");
    pressArrowRight(input);
    expect(view.fired()).toBe(0);
  } finally {
    field.remove();
    view.dispose();
  }
});

Deno.test("cf-keybind fires for a key on a non-editable island inside an editor", () => {
  const view = arrowRightBinding();
  const island = document.createElement("button");
  const wrapper = document.createElement("span");
  wrapper.contentEditable = "false";
  wrapper.append(island);
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.append(wrapper);
  const tree = nestedInShadow(editor);
  try {
    pressArrowRight(island);
    expect(view.fired()).toBe(1);
  } finally {
    tree.dispose();
    view.dispose();
  }
});
