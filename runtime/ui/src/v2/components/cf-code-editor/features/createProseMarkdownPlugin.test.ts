// First, so that the document it installs is there when CodeMirror loads.
import { window } from "../../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import { createProseMarkdownPlugin } from "./prose-markdown.ts";

/** Every view `openView()` has opened and `closeViews()` not yet destroyed. */
const openViews: EditorView[] = [];

/**
 * An editor showing `doc` as GFM markdown in the test document, with the
 * cursor at `cursor` and the prose plugin installed.
 */
function openView(
  doc: string,
  cursor = 0,
  extensions: Extension = [],
): EditorView {
  const created = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [
      markdown({ extensions: GFM }),
      createProseMarkdownPlugin(),
      extensions,
    ],
  });
  // A state parses for a fixed time after it is created and after each edit,
  // and keeps whatever tree it has by then, which a loaded machine can leave
  // short of the end; a background parse brings the rest later. Parsing the
  // rest at once, and taking a state that holds the whole tree, makes what the
  // view draws independent of the machine's speed.
  const finishParse = (state: EditorState) =>
    ensureSyntaxTree(state, state.doc.length, Infinity);
  finishParse(created);
  const view = new EditorView({
    state: created.update({}).state,
    parent: document.body,
    dispatchTransactions(transactions, view) {
      const { state } = transactions[transactions.length - 1];
      finishParse(state);
      view.update([...transactions, state.update({})]);
    },
  });
  openViews.push(view);
  return view;
}

/** Destroys every view `openView()` opened, and empties the document. */
function closeViews(): void {
  for (const view of openViews.splice(0)) view.destroy();
  window.document.body.replaceChildren();
}

/** Every element in `view`'s content matching `selector`. */
function elementsOf(view: EditorView, selector: string): Element[] {
  return Array.from(view.contentDOM.querySelectorAll(selector));
}

/** The text of every element in `view`'s content matching `selector`. */
function textsOf(view: EditorView, selector: string): Array<string | null> {
  return elementsOf(view, selector).map((element) => element.textContent);
}

/** The task checkbox in `view`'s content; the document must hold one. */
function checkboxOf(view: EditorView): HTMLInputElement {
  const checkbox = view.contentDOM.querySelector("input.cm-prose-checkbox");
  if (!(checkbox instanceof HTMLInputElement)) {
    throw new Error("The view draws no task checkbox.");
  }
  return checkbox;
}

/** Presses the mouse button on `target`, and returns the event. */
function pressOn(target: Element): MouseEvent {
  const event = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe("createProseMarkdownPlugin()", () => {
  afterEach(closeViews);

  describe("list markers", () => {
    it("renders a bullet in place of an unordered list's marker", () => {
      const view = openView("- one\n- two");
      expect(textsOf(view, ".cm-prose-bullet")).toEqual(["•", "•"]);
      expect(view.contentDOM.textContent).toBe("•one•two");
    });

    it("renders each ordered list item's number in place of its marker", () => {
      const view = openView("1. one\n2. two");
      expect(textsOf(view, ".cm-prose-list-number")).toEqual(["1.", "2."]);
      expect(view.contentDOM.textContent).toBe("1.one2.two");
    });

    it("renders the number an edit gives a marker, keeping the others", () => {
      const view = openView("1. one\n2. two");
      const [first, second] = elementsOf(view, ".cm-prose-list-number");

      view.dispatch({ changes: { from: 0, to: 1, insert: "3" } });
      const [renumbered, kept] = elementsOf(view, ".cm-prose-list-number");
      expect(renumbered.textContent).toBe("3.");
      expect(renumbered).not.toBe(first);
      expect(kept).toBe(second);
    });

    it("renders the raw marker on the line the focused cursor is on", () => {
      const view = openView("- one\n- two");
      view.focus();
      view.dispatch({ selection: { anchor: 2 } });
      expect(view.contentDOM.textContent).toBe("- one•two");
    });

    it("renders the bullet again once the editor loses focus", () => {
      const time = new FakeTime();
      try {
        const view = openView("- one");
        view.focus();
        view.dispatch({ selection: { anchor: 2 } });
        expect(view.contentDOM.textContent).toBe("- one");

        // CodeMirror reports a focus change a few milliseconds after the
        // event, with no transaction of its own.
        view.contentDOM.blur();
        time.tick(50);
        expect(view.contentDOM.textContent).toBe("•one");
      } finally {
        time.restore();
      }
    });
  });

  describe("footnotes", () => {
    it("renders a footnote reference as its label in superscript", () => {
      const view = openView("See[^note].");
      expect(textsOf(view, "sup.cm-prose-footnote")).toEqual(["note"]);
      expect(view.contentDOM.textContent).toBe("Seenote.");
    });

    it("renders the label an edit gives a footnote reference", () => {
      const view = openView("See[^a].");
      const [before] = elementsOf(view, "sup.cm-prose-footnote");

      view.dispatch({ changes: { from: 5, to: 6, insert: "b" } });
      const [after] = elementsOf(view, "sup.cm-prose-footnote");
      expect(after.textContent).toBe("b");
      expect(after).not.toBe(before);
    });
  });

  describe("horizontal rules", () => {
    it("renders a rule in place of `---`", () => {
      const view = openView("a\n\n---\n\nb");
      expect(elementsOf(view, "hr.cm-prose-hr")).toHaveLength(1);
      expect(view.contentDOM.textContent).toBe("ab");
    });
  });

  describe("task checkboxes", () => {
    it("renders an unchecked checkbox for `[ ]` and a checked one for `[x]`", () => {
      const unchecked = openView("- [ ] open");
      const checked = openView("- [x] done");
      expect(checkboxOf(unchecked).checked).toBe(false);
      expect(checkboxOf(checked).checked).toBe(true);
    });

    it("checks an unchecked task when the checkbox is pressed", () => {
      const view = openView("- [ ] open");
      const event = pressOn(checkboxOf(view));
      expect(view.state.doc.toString()).toBe("- [x] open");
      expect(checkboxOf(view).checked).toBe(true);
      expect(event.defaultPrevented).toBe(true);
    });

    it("unchecks a checked task when the checkbox is pressed", () => {
      const view = openView("- [x] done");
      pressOn(checkboxOf(view));
      expect(view.state.doc.toString()).toBe("- [ ] done");
      expect(checkboxOf(view).checked).toBe(false);
    });

    it("passes an event on the checkbox to the editor's own handlers", () => {
      const clicks: EventTarget[] = [];
      const view = openView(
        "- [ ] open",
        0,
        EditorView.domEventHandlers({
          click: (event) => {
            if (event.target !== null) clicks.push(event.target);
          },
        }),
      );
      const checkbox = checkboxOf(view);
      checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(clicks).toEqual([checkbox]);
    });

    it("toggles only the task whose checkbox is pressed", () => {
      const view = openView("- [ ] one\n- [ ] two");
      const [, second] = elementsOf(view, "input.cm-prose-checkbox");
      pressOn(second);
      expect(view.state.doc.toString()).toBe("- [ ] one\n- [x] two");
    });
  });

  it("decorates the rest of a long document once its parse reaches it", () => {
    // A new state parses only its first few thousand characters; the rest of
    // the tree arrives in a later transaction, as the background parse does.
    const plugin = createProseMarkdownPlugin();
    const doc = "- item\n".repeat(2000);
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [markdown({ extensions: GFM }), plugin],
      }),
      parent: document.body,
    });
    openViews.push(view);
    const bullets = () => {
      let count = 0;
      view.plugin(plugin)?.decorations.between(0, doc.length, () => {
        count++;
      });
      return count;
    };
    expect(bullets()).toBeLessThan(1000);

    ensureSyntaxTree(view.state, doc.length, Infinity);
    view.dispatch({});

    expect(bullets()).toBe(2000);
  });

  it("keeps every widget's element through an edit that leaves the widget as it was", () => {
    // CodeMirror redraws a widget only when the new one does not compare
    // equal to the old, so an element that survives the edit is one each
    // widget's comparison kept.

    const view = openView("1. one\n\n- [ ] task\n\nSee[^1].\n\n---\n\nx");
    const selector =
      ".cm-prose-list-number, .cm-prose-bullet, input.cm-prose-checkbox, " +
      "sup.cm-prose-footnote, hr.cm-prose-hr";
    const before = elementsOf(view, selector);
    expect(before).toHaveLength(5);

    view.dispatch({ changes: { from: view.state.doc.length, insert: "y" } });
    const after = elementsOf(view, selector);
    expect(after).toHaveLength(5);
    after.forEach((element, index) => expect(element).toBe(before[index]));
  });
});
