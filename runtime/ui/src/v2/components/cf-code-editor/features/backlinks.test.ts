// First, so that the document it installs is there when CodeMirror loads.
import { window } from "../../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { cursorCharRight } from "@codemirror/commands";
import {
  atomicBacklinkRanges,
  backlinkEditFilter,
  backlinkField,
  type BacklinkInfo,
  createBacklinkDecorationPlugin,
  parseBacklinks,
} from "./backlinks.ts";

//
// Helpers
//

/** Create a headless EditorState with backlink extensions loaded. */
function createState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [backlinkField, backlinkEditFilter],
  });
}

/** Every view `openView()` has opened and `closeViews()` not yet destroyed. */
const openViews: EditorView[] = [];

/**
 * An editor showing `doc` in the test document, with the selection running
 * from `anchor` to `head` and every backlink extension installed.
 */
function openView(doc: string, anchor = 0, head = anchor): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [
        backlinkField,
        backlinkEditFilter,
        atomicBacklinkRanges,
        createBacklinkDecorationPlugin(),
      ],
    }),
    parent: document.body,
  });
  openViews.push(view);
  return view;
}

/** Destroys every view `openView()` opened, and empties the document. */
function closeViews(): void {
  for (const view of openViews.splice(0)) view.destroy();
  window.document.body.replaceChildren();
}

/** The text of every element in `view`'s content matching `selector`. */
function textsOf(view: EditorView, selector: string): string[] {
  return Array.from(
    view.contentDOM.querySelectorAll(selector),
    (element) => element.textContent,
  );
}

/** The positions `cursorCharRight` visits, starting from the selection. */
function stepsRight(view: EditorView, count: number): number[] {
  const steps: number[] = [];
  for (let step = 0; step < count; step++) {
    cursorCharRight(view);
    steps.push(view.state.selection.main.head);
  }
  return steps;
}

/** Shorthand to read backlinkField from a state. */
function getBacklinks(state: EditorState): BacklinkInfo[] {
  return state.field(backlinkField);
}

//
// parseBacklinks() - Backlink parsing
//

describe("parseBacklinks", () => {
  it("returns empty array for empty string", () => {
    expect(parseBacklinks("")).toEqual([]);
  });

  it("returns empty array for plain text with no backlinks", () => {
    expect(parseBacklinks("Hello world, no links here.")).toEqual([]);
  });

  it("parses a single complete backlink [[Name (id)]]", () => {
    const doc = "See [[My Note (abc123)]] for details";
    const result = parseBacklinks(doc);
    expect(result).toHaveLength(1);

    const bl = result[0];
    expect(bl.name).toBe("My Note");
    expect(bl.id).toBe("abc123");
    expect(bl.from).toBe(4); // start of [[
    expect(bl.to).toBe(24); // end of ]]
    expect(bl.nameFrom).toBe(6); // after [[
    expect(bl.nameTo).toBe(13); // end of "My Note"
  });

  it("parses a single incomplete backlink [[text]]", () => {
    const doc = "Check [[todo item]] later";
    const result = parseBacklinks(doc);
    expect(result).toHaveLength(1);

    const bl = result[0];
    expect(bl.name).toBe("todo item");
    expect(bl.id).toBe(""); // no ID
    expect(bl.from).toBe(6);
    expect(bl.to).toBe(19);
    expect(bl.nameFrom).toBe(8);
    expect(bl.nameTo).toBe(17);
  });

  it("parses multiple backlinks in one string", () => {
    const doc = "Link [[A (1)]] and [[B (2)]] here";
    const result = parseBacklinks(doc);
    expect(result).toHaveLength(2);

    expect(result[0].name).toBe("A");
    expect(result[0].id).toBe("1");
    expect(result[1].name).toBe("B");
    expect(result[1].id).toBe("2");
  });

  it("handles adjacent backlinks", () => {
    const doc = "[[A (1)]][[B (2)]]";
    const result = parseBacklinks(doc);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("A");
    expect(result[0].id).toBe("1");
    expect(result[0].to).toBe(9);
    expect(result[1].name).toBe("B");
    expect(result[1].id).toBe("2");
    expect(result[1].from).toBe(9);
  });

  it("handles backlinks at string boundaries", () => {
    // Start of string
    const startDoc = "[[Start (s1)]] rest";
    const startResult = parseBacklinks(startDoc);
    expect(startResult).toHaveLength(1);
    expect(startResult[0].from).toBe(0);
    expect(startResult[0].name).toBe("Start");

    // End of string
    const endDoc = "end [[Tail (t1)]]";
    const endResult = parseBacklinks(endDoc);
    expect(endResult).toHaveLength(1);
    expect(endResult[0].to).toBe(endDoc.length);
    expect(endResult[0].name).toBe("Tail");
  });

  it("handles ID with hyphens and mixed chars", () => {
    const doc = "[[Note (abc-123-xyz)]]";
    const result = parseBacklinks(doc);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("abc-123-xyz");
    expect(result[0].name).toBe("Note");
  });

  it("does not match unclosed brackets [[text", () => {
    const doc = "This is [[incomplete";
    const result = parseBacklinks(doc);
    expect(result).toEqual([]);
  });

  it("handles mixed complete and incomplete backlinks", () => {
    const doc = "[[Done (d1)]] and [[Pending]]";
    const result = parseBacklinks(doc);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("d1");
    expect(result[0].name).toBe("Done");
    expect(result[1].id).toBe("");
    expect(result[1].name).toBe("Pending");
  });
});

//
// backlinkField StateField - Position tracking through edits
//

describe("backlinkField", () => {
  it("parses backlinks from initial document", () => {
    const state = createState("Hello [[World (w1)]]");
    const bls = getBacklinks(state);
    expect(bls).toHaveLength(1);
    expect(bls[0].name).toBe("World");
    expect(bls[0].id).toBe("w1");
  });

  it("updates positions when text is inserted before a backlink", () => {
    const state = createState("X [[A (1)]]");
    const blsBefore = getBacklinks(state);
    expect(blsBefore[0].from).toBe(2);

    const tr = state.update({
      changes: { from: 0, to: 0, insert: "YY" },
    });
    const blsAfter = getBacklinks(tr.state);
    expect(blsAfter).toHaveLength(1);
    expect(blsAfter[0].from).toBe(4); // shifted by 2
    expect(blsAfter[0].name).toBe("A");
    expect(blsAfter[0].id).toBe("1");
  });

  it("updates when text is deleted before a backlink", () => {
    const state = createState("ABCD[[E (e)]]");
    expect(getBacklinks(state)[0].from).toBe(4);

    const tr = state.update({
      changes: { from: 0, to: 2, insert: "" },
    });
    const blsAfter = getBacklinks(tr.state);
    expect(blsAfter).toHaveLength(1);
    expect(blsAfter[0].from).toBe(2); // shifted left by 2
  });

  it("detects a newly added backlink", () => {
    const state = createState("Hello ");
    expect(getBacklinks(state)).toHaveLength(0);

    const tr = state.update({
      changes: { from: 6, to: 6, insert: "[[New (n1)]]" },
    });
    const blsAfter = getBacklinks(tr.state);
    expect(blsAfter).toHaveLength(1);
    expect(blsAfter[0].name).toBe("New");
    expect(blsAfter[0].id).toBe("n1");
  });

  it("detects removal of a backlink", () => {
    const doc = "Keep [[Gone (g1)]] this";
    const state = createState(doc);
    expect(getBacklinks(state)).toHaveLength(1);

    const tr = state.update({
      changes: { from: 5, to: 19, insert: "" },
    });
    expect(getBacklinks(tr.state)).toHaveLength(0);
  });

  it("does not reparse when doc is unchanged (selection-only transaction)", () => {
    const state = createState("[[A (1)]]");
    const bls1 = getBacklinks(state);

    const tr = state.update({ selection: { anchor: 3 } });
    const bls2 = getBacklinks(tr.state);
    // Same reference — the update path was skipped
    expect(bls2).toBe(bls1);
  });
});

//
// backlinkEditFilter - Transaction filter protecting IDs
//

describe("backlinkEditFilter", () => {
  it("allows edits outside any backlink", () => {
    const state = createState("Hello [[World (w1)]] end");
    const tr = state.update({
      changes: { from: 0, to: 5, insert: "Hi" },
    });
    expect(tr.state.doc.toString()).toBe("Hi [[World (w1)]] end");
  });

  it("allows edits within the name portion of a backlink", () => {
    const state = createState("[[World (w1)]]");
    const bls = getBacklinks(state);
    expect(bls[0].nameFrom).toBe(2);
    expect(bls[0].nameTo).toBe(7);

    const tr = state.update({
      changes: { from: 4, to: 4, insert: "X" },
    });
    expect(tr.state.doc.toString()).toBe("[[WoXrld (w1)]]");
  });

  it("blocks edits that start inside the ID portion", () => {
    // [[World (w1)]] positions:
    //   0: [  1: [  2: W  3: o  4: r  5: l  6: d  7: ' '  8: (  9: w  10: 1  11: )  12: ]  13: ]
    // nameTo=7, to=14. Edit at position 9 starts inside ID area.
    const state = createState("[[World (w1)]]");

    const tr = state.update({
      changes: { from: 9, to: 10, insert: "X" },
    });

    expect(tr.state.doc.toString()).toBe("[[World (w1)]]");
  });

  it("truncates edits spanning from name into ID", () => {
    // Edit from=5 (inside "Hello") to=10 (inside " (h1)") spans the name/ID boundary.
    // The filter should truncate the deletion to bl.nameTo so the ID is preserved.
    const state = createState("[[Hello (h1)]]");
    // [[Hello (h1)]]
    //   ^    ^
    //   2    7  ← nameFrom=2, nameTo=7
    const tr = state.update({
      changes: { from: 5, to: 10, insert: "X" },
    });
    // Deletion truncated to nameTo=7; insert "X" applied at position 5
    expect(tr.state.doc.toString()).toBe("[[HelX (h1)]]");
  });

  it("allows deletion of an entire backlink", () => {
    const state = createState("before [[Note (n1)]] after");
    const bl = getBacklinks(state)[0];

    const tr = state.update({
      changes: { from: bl.from, to: bl.to, insert: "" },
    });
    expect(tr.state.doc.toString()).toBe("before  after");
    expect(getBacklinks(tr.state)).toHaveLength(0);
  });

  it("allows edits on incomplete backlinks (no ID to protect)", () => {
    const state = createState("[[pending]]");
    const tr = state.update({
      changes: { from: 3, to: 3, insert: "X" },
    });
    expect(tr.state.doc.toString()).toBe("[[pXending]]");
  });

  it("blocks an ID edit while applying an edit between an incomplete backlink's closing brackets", () => {
    // An incomplete backlink has no ID, so even an edit inside its `]]` is
    // its user's to make.
    const state = createState("[[todo]] [[A (a1)]]");
    const tr = state.update({
      changes: [
        { from: 7, insert: "X" },
        { from: 14, to: 15, insert: "Y" },
      ],
    });
    expect(tr.state.doc.toString()).toBe("[[todo]X] [[A (a1)]]");
  });

  it("multi-change transaction: blocks ID edit while allowing other changes", () => {
    // Backlink [[A (a1)]]: from=7, to=17, nameFrom=9, nameTo=10, id="a1"
    const state = createState("prefix [[A (a1)]] suffix");
    const tr = state.update({
      changes: [
        { from: 0, to: 6, insert: "pre" },
        // Position 12 is inside " (a1)" — the ID area (nameTo=10, to=17)
        { from: 12, to: 13, insert: "X" },
      ],
    });
    // Outside change is kept; ID change is dropped
    expect(tr.state.doc.toString()).toBe("pre [[A (a1)]] suffix");
  });
});

//
// Enter keymap conditions
//

describe("Enter keymap conditions", () => {
  it("cursor position determines Enter behavior", () => {
    // Keymap condition: bl.id && pos >= bl.from && pos < bl.to
    const state = createState("text [[Note (n1)]] more");
    const bl = getBacklinks(state)[0];

    // Inside backlink → Enter consumed, cursor moves to bl.to
    const insidePos = bl.nameFrom + 1;
    expect(insidePos >= bl.from && insidePos < bl.to).toBe(true);
    expect(bl.id).toBeTruthy();

    // Before backlink → Enter falls through
    expect(0 >= bl.from && 0 < bl.to).toBe(false);

    // bl.to is the dispatch target — the character after ]] in the doc
    expect(state.doc.sliceString(bl.to, bl.to + 1)).toBe(" ");
  });
});

//
// atomicBacklinkRanges - Cursor motion over hidden syntax
//

describe("atomicBacklinkRanges", () => {
  afterEach(closeViews);

  it("moves the cursor over the brackets and the ID of a complete backlink in one step", () => {
    // "a [[Foo (id1)]] b": the name runs from 4 to 7, and the backlink ends
    // at 15.
    const view = openView("a [[Foo (id1)]] b", 2);
    expect(stepsRight(view, 5)).toEqual([4, 5, 6, 7, 15]);
  });

  it("moves the cursor one character at a time through an incomplete backlink", () => {
    const view = openView("[[ab]]");
    expect(stepsRight(view, 6)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("moves the cursor one character at a time through a backlink spanning lines", () => {
    // The whitespace before the ID may be a line break.
    const view = openView("[[a\n(id1)]]");
    expect(getBacklinks(view.state)[0].id).toBe("id1");
    expect(stepsRight(view, 4)).toEqual([1, 2, 3, 4]);
  });
});

//
// createBacklinkDecorationPlugin() - Rendering
//

describe("createBacklinkDecorationPlugin()", () => {
  afterEach(closeViews);

  it("renders a complete backlink as a pill showing only its name", () => {
    const view = openView("a [[Foo (id1)]] b", 5);
    expect(view.contentDOM.textContent).toBe("a Foo b");
    expect(textsOf(view, ".cm-backlink-pill")).toEqual(["Foo"]);
  });

  it("renders `[[Name]]` with the ID hidden while the focused cursor is inside", () => {
    const view = openView("a [[Foo (id1)]] b");
    view.focus();
    view.dispatch({ selection: { anchor: 5 } });
    expect(view.contentDOM.textContent).toBe("a [[Foo]] b");
    expect(textsOf(view, ".cm-backlink-pill")).toEqual([]);
  });

  it("renders `[[Name]]` while a focused selection overlaps the backlink", () => {
    // The selection's head is at 0, outside the backlink.
    const view = openView("a [[Foo (id1)]] b", 16, 0);
    view.focus();
    view.dispatch({ selection: { anchor: 16, head: 0 } });
    expect(view.contentDOM.textContent).toBe("a [[Foo]] b");
  });

  it("renders a pill again once the editor loses focus", () => {
    const time = new FakeTime();
    try {
      const view = openView("a [[Foo (id1)]] b");
      view.focus();
      view.dispatch({ selection: { anchor: 5 } });
      expect(view.contentDOM.textContent).toBe("a [[Foo]] b");

      // CodeMirror reports a focus change a few milliseconds after the
      // event, with no transaction of its own.
      view.contentDOM.blur();
      time.tick(50);
      expect(view.contentDOM.textContent).toBe("a Foo b");
      expect(textsOf(view, ".cm-backlink-pill")).toEqual(["Foo"]);
    } finally {
      time.restore();
    }
  });

  it("renders an incomplete backlink as a pending pill when the cursor is elsewhere", () => {
    const view = openView("a [[todo]] b");
    view.focus();
    view.dispatch({ selection: { anchor: 12 } });
    expect(view.contentDOM.textContent).toBe("a todo b");
    expect(textsOf(view, ".cm-backlink-pending")).toEqual(["todo"]);
    expect(textsOf(view, ".cm-backlink-editing")).toEqual([]);
  });

  it("renders an incomplete backlink in full while the focused cursor is inside", () => {
    const view = openView("a [[todo]] b");
    view.focus();
    view.dispatch({ selection: { anchor: 5 } });
    expect(view.contentDOM.textContent).toBe("a [[todo]] b");
    expect(textsOf(view, ".cm-backlink-editing")).toEqual(["[[todo]]"]);
    expect(textsOf(view, ".cm-backlink-pending")).toEqual([]);
  });

  it("renders a backlink spanning lines as plain text", () => {
    const view = openView("[[a\n(id1)]]");
    expect(view.contentDOM.textContent).toBe("[[a(id1)]]");
    expect(textsOf(view, ".cm-backlink-pill")).toEqual([]);
  });

  it("renders a backlink added by an edit", () => {
    const view = openView("a b", 3);
    view.dispatch({ changes: { from: 1, insert: " [[Foo (id1)]]" } });
    expect(view.contentDOM.textContent).toBe("a Foo b");
  });

  it("renders a backlink an edit breaks as plain text", () => {
    // The edit keeps the document's length, so the viewport stays as it was.
    const view = openView("a [[Foo (id1)]] b", 17);
    view.dispatch({ changes: { from: 2, to: 3, insert: "x" } });
    expect(view.contentDOM.textContent).toBe("a x[Foo (id1)]] b");
    expect(textsOf(view, ".cm-backlink-pill")).toEqual([]);
  });
});
