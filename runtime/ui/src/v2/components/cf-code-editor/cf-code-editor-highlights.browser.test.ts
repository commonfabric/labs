/**
 * Tests what a host of a mounted editor hears about its highlights and the
 * selection: the mark a range renders as, the click on it, and the selection
 * event. The marks and the mousedown path need a laid-out view, which is why
 * these run under deno-web-test rather than `deno test`. The harness
 * registers tests through `Deno.test` and calls each one with no arguments,
 * so the BDD functions the rest of the repository uses are not available
 * here.
 */

import { assert, assertEquals } from "@std/assert";

import { StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { CFCodeEditor } from "./index.ts";

interface Mounted {
  element: CFCodeEditor;
  done(): void;
}

/** A mounted editor over `text`, with its view built. */
async function mount(text: string): Promise<Mounted> {
  const element = new CFCodeEditor();
  element.value = text;
  document.body.appendChild(element);
  await element.updateComplete;
  assert(element.editorView, "the component builds an editor view");
  return { element, done: () => element.remove() };
}

/** The next `name` event the element dispatches, with its detail. */
function nextEvent<T>(element: CFCodeEditor, name: string): Promise<T> {
  return new Promise((resolve) => {
    element.addEventListener(
      name,
      (event) => resolve((event as CustomEvent<T>).detail),
      { once: true },
    );
  });
}

/** The marks the editor draws, by their highlight id. */
function marks(element: CFCodeEditor): HTMLElement[] {
  return [
    ...(element.shadowRoot?.querySelectorAll("[data-highlight-id]") ?? []),
  ].filter((node): node is HTMLElement => node instanceof HTMLElement);
}

Deno.test("a highlight renders as a mark carrying its id and kind over the text it names", async () => {
  const { element, done } = await mount("hello world");
  try {
    element.highlights = [
      { id: "one", from: 0, to: 5 },
      { id: "two", from: 6, to: 11, kind: "selected" },
    ];
    await element.updateComplete;
    const rendered = marks(element);
    assertEquals(
      rendered.map((mark) => [
        mark.dataset.highlightId,
        mark.textContent,
        mark.classList.contains("cm-highlight"),
        mark.classList.contains("cm-highlight-selected"),
      ]),
      [["one", "hello", true, false], ["two", "world", true, true]],
    );
  } finally {
    done();
  }
});

Deno.test("a mousedown on a mark fires `cf-highlight-click` with the mark's id", async () => {
  const { element, done } = await mount("hello world");
  try {
    element.highlights = [{ id: "one", from: 6, to: 11 }];
    await element.updateComplete;
    const [mark] = marks(element);
    assert(mark, "the highlight renders as a mark");
    const clicked = nextEvent<{ id: string }>(element, "cf-highlight-click");
    mark.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, composed: true }),
    );
    assertEquals(await clicked, { id: "one" });
  } finally {
    done();
  }
});

Deno.test("a selection fires `cf-selection-change` with the range and its text, and clearing it fires once more", async () => {
  const { element, done } = await mount("hello world");
  try {
    const view = element.editorView!;
    const selected = nextEvent<{ from: number; to: number; text: string }>(
      element,
      "cf-selection-change",
    );
    view.dispatch({ selection: { anchor: 6, head: 11 } });
    assertEquals(await selected, { from: 6, to: 11, text: "world" });

    const cleared = nextEvent<{ from: number; to: number; text: string }>(
      element,
      "cf-selection-change",
    );
    view.dispatch({ selection: { anchor: 3 } });
    assertEquals(await cleared, { from: 3, to: 3, text: "" });
  } finally {
    done();
  }
});

Deno.test("a collaborator's edit ahead of a selection fires `cf-selection-change` with where it moved", async () => {
  const { element, done } = await mount("hello world");
  try {
    const view = element.editorView!;
    const selected = nextEvent(element, "cf-selection-change");
    view.dispatch({ selection: { anchor: 6, head: 11 } });
    await selected;
    // The collaborator inserts a copy of the selected text at the selection's
    // start: the selection stays on the text it was made over.
    const moved = nextEvent<{ from: number; to: number; text: string }>(
      element,
      "cf-selection-change",
    );
    view.dispatch({
      changes: { from: 6, insert: "world " },
      annotations: Transaction.remote.of(true),
    });
    assertEquals(await moved, { from: 12, to: 17, text: "world" });
  } finally {
    done();
  }
});

Deno.test("a caret move with nothing selected fires no `cf-selection-change`", async () => {
  const { element, done } = await mount("hello world");
  try {
    const view = element.editorView!;
    const fired: unknown[] = [];
    element.addEventListener(
      "cf-selection-change",
      (event) => fired.push((event as CustomEvent).detail),
    );
    view.dispatch({ selection: { anchor: 2 } });
    view.dispatch({ selection: { anchor: 4 } });
    // A selection after the moves is what proves the listener was live.
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    assertEquals(fired, [{ from: 0, to: 5, text: "hello" }]);
  } finally {
    done();
  }
});

Deno.test("a local edit before a highlight fires `cf-highlights-mapped` with the moved range", async () => {
  const { element, done } = await mount("hello world");
  try {
    element.highlights = [{ id: "one", from: 6, to: 11 }];
    await element.updateComplete;
    const mapped = nextEvent<{ highlights: unknown[] }>(
      element,
      "cf-highlights-mapped",
    );
    element.editorView!.dispatch({ changes: { from: 0, insert: "oh " } });
    assertEquals(await mapped, {
      highlights: [{ id: "one", from: 9, to: 14 }],
    });
  } finally {
    done();
  }
});

Deno.test("highlights set before the document arrives are drawn once it does", async () => {
  const { element, done } = await mount("");
  try {
    element.highlights = [{ id: "one", from: 6, to: 11 }];
    await element.updateComplete;
    assertEquals(marks(element), []);
    // The document arrives the way a collaboration snapshot does: a remote
    // transaction replacing the whole of an empty editor.
    element.editorView!.dispatch({
      changes: { from: 0, insert: "hello world" },
      annotations: Transaction.remote.of(true),
    });
    assertEquals(marks(element).map((mark) => mark.textContent), ["world"]);
  } finally {
    done();
  }
});

Deno.test("a host handing back an older report after a later one leaves the editor's set where typing moved it", async () => {
  const { element, done } = await mount("hello world");
  try {
    element.highlights = [{ id: "one", from: 6, to: 11 }];
    await element.updateComplete;
    const reports: { id: string; from: number; to: number }[][] = [];
    element.addEventListener(
      "cf-highlights-mapped",
      (event) => reports.push((event as CustomEvent).detail.highlights),
    );
    const view = element.editorView!;
    // Two keystrokes before the host has answered the first.
    view.dispatch({ changes: { from: 0, insert: "a" } });
    view.dispatch({ changes: { from: 0, insert: "b" } });
    assertEquals(reports, [
      [{ id: "one", from: 7, to: 12 }],
      [{ id: "one", from: 8, to: 13 }],
    ]);
    // The first report comes back: the view is past it, and stays put.
    element.highlights = reports[0];
    await element.updateComplete;
    assertEquals(marks(element).map((mark) => mark.textContent), ["world"]);
    // A host still behind can change what is marked and how, over the text
    // the view has the ranges on.
    element.highlights = [
      { id: "one", from: 7, to: 12, kind: "selected" },
      { id: "two", from: 0, to: 1 },
    ];
    await element.updateComplete;
    assertEquals(
      marks(element).map((mark) => [
        mark.textContent,
        mark.classList.contains("cm-highlight-selected"),
      ]),
      [["b", false], ["world", true]],
    );
    // The host catches up to the second report and takes back its addition;
    // from here its positions are set as given.
    element.highlights = reports[1];
    await element.updateComplete;
    assertEquals(marks(element).map((mark) => mark.textContent), ["world"]);
    element.highlights = [{ id: "one", from: 2, to: 7 }];
    await element.updateComplete;
    assertEquals(marks(element).map((mark) => mark.textContent), ["hello"]);
  } finally {
    done();
  }
});

Deno.test("an edit undone before the host answers reports the restored ranges, and a delayed echo of the edit has no effect", async () => {
  const { element, done } = await mount("hello world");
  try {
    element.highlights = [{ id: "one", from: 6, to: 11 }];
    await element.updateComplete;
    const reports: { id: string; from: number; to: number }[][] = [];
    element.addEventListener(
      "cf-highlights-mapped",
      (event) => reports.push((event as CustomEvent).detail.highlights),
    );
    const view = element.editorView!;
    view.dispatch({ changes: { from: 0, insert: "a" } });
    // The view is back on the host's value before the host has answered.
    // The host is about to store the first report, so the restored
    // positions are reported too.
    view.dispatch({ changes: { from: 0, to: 1 } });
    assertEquals(reports, [
      [{ id: "one", from: 7, to: 12 }],
      [{ id: "one", from: 6, to: 11 }],
    ]);
    // The echo of the undone edit arrives: the view stays where it is.
    element.highlights = reports[0];
    await element.updateComplete;
    assertEquals(marks(element).map((mark) => mark.textContent), ["world"]);
    // The host catches up to the restored positions; from here its
    // positions are set as given.
    element.highlights = reports[1];
    await element.updateComplete;
    element.highlights = [{ id: "one", from: 0, to: 5 }];
    await element.updateComplete;
    assertEquals(marks(element).map((mark) => mark.textContent), ["hello"]);
  } finally {
    done();
  }
});

Deno.test("a collaborator's edit arriving before the host answers reports where it moved the ranges", async () => {
  const { element, done } = await mount("hello world world");
  try {
    element.highlights = [{ id: "one", from: 6, to: 11 }];
    await element.updateComplete;
    const reports: { id: string; from: number; to: number }[][] = [];
    element.addEventListener(
      "cf-highlights-mapped",
      (event) => reports.push((event as CustomEvent).detail.highlights),
    );
    const view = element.editorView!;
    // A collaborator's edit with nothing outstanding is theirs to report.
    view.dispatch({
      changes: { from: 17, insert: "!" },
      annotations: Transaction.remote.of(true),
    });
    assertEquals(reports, []);
    // This editor's edit, then a collaborator's concurrent one ahead of the
    // range: the host would otherwise store the first report against a
    // document neither editor has anymore.
    view.dispatch({ changes: { from: 0, insert: "a" } });
    view.dispatch({
      changes: { from: 0, insert: "b" },
      annotations: Transaction.remote.of(true),
    });
    assertEquals(reports, [
      [{ id: "one", from: 7, to: 12 }],
      [{ id: "one", from: 8, to: 13 }],
    ]);
    // The first report comes back before the merged one: the view stays
    // put, then takes the host's positions once it has caught up.
    element.highlights = reports[0];
    await element.updateComplete;
    assertEquals(marks(element).map((mark) => mark.textContent), ["world"]);
    element.highlights = reports[1];
    await element.updateComplete;
    element.highlights = [{ id: "one", from: 2, to: 7 }];
    await element.updateComplete;
    assertEquals(marks(element).map((mark) => mark.textContent), ["hello"]);
  } finally {
    done();
  }
});

Deno.test("a host handing back the ranges the editor reported leaves the editor's set as it is", async () => {
  const { element, done } = await mount("hello world");
  try {
    element.highlights = [{ id: "one", from: 6, to: 11 }];
    await element.updateComplete;
    const mapped = nextEvent<
      { highlights: { id: string; from: number; to: number }[] }
    >(
      element,
      "cf-highlights-mapped",
    );
    element.editorView!.dispatch({ changes: { from: 0, insert: "oh " } });
    const reported = (await mapped).highlights;
    const view = element.editorView!;
    let updates = 0;
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of(() => updates++),
      ),
    });
    const before = updates;
    element.highlights = reported;
    await element.updateComplete;
    assertEquals(updates, before);
    assertEquals(marks(element).map((mark) => mark.textContent), ["world"]);
  } finally {
    done();
  }
});
