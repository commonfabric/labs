// First, so that the document it installs is there when CodeMirror loads.
import { window } from "../../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import {
  Compartment,
  EditorState,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import { EditorView, type WidgetType } from "@codemirror/view";
import { GFM } from "@lezer/markdown";

import { mathMarkdown } from "./math-syntax.ts";
import {
  buildMathDecorations,
  type FormulaRenderer,
  proseMath,
} from "./prose-math.ts";
import { afterEach, describe, it } from "@commonfabric/test-support/test";

//
// Helpers
//

/** A headless state parsing `doc` as Markdown with formulas. */
function createState(doc: string, cursor = 0): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM, mathMarkdown] })],
    selection: { anchor: cursor },
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

/** The parse of `state`, finished to the end of its document. */
function finishParse(state: EditorState): void {
  ensureSyntaxTree(state, state.doc.length, Infinity);
}

/** Every view `openView()` has opened and `closeViews()` not yet destroyed. */
const openViews: EditorView[] = [];

/**
 * An editor showing `doc` in the test document with the cursor at `cursor`,
 * parsing it as Markdown with formulas, with `extensions` added. Every
 * transaction it dispatches is pushed onto `dispatched`.
 */
function openView(
  doc: string,
  cursor: number,
  extensions: Extension,
  dispatched: Transaction[] = [],
): EditorView {
  const created = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [
      markdown({ extensions: [GFM, mathMarkdown] }),
      extensions,
    ],
  });
  finishParse(created);
  const view = new EditorView({
    state: created.update({}).state,
    parent: document.body,
    dispatchTransactions(transactions, view) {
      for (const transaction of transactions) dispatched.push(transaction);
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

/**
 * A renderer that draws each formula as its TeX in a `<b>`, marked `display`
 * in display style and prefixed with `label`, and records each call in
 * `calls`.
 */
function recordingRenderer(label = "") {
  const calls: string[] = [];
  const render: FormulaRenderer = (tex, display) => {
    calls.push(`${display ? "display" : "inline"} ${tex}`);
    return { html: `<b>${label}${tex}${display ? " (display)" : ""}</b>` };
  };
  return { calls, render };
}

/** The text of every element in `view`'s content matching `selector`. */
function textsOf(view: EditorView, selector: string): Array<string | null> {
  return Array.from(
    view.contentDOM.querySelectorAll(selector),
    (element) => element.textContent,
  );
}

/** The widget of each replacing decoration `state` draws without focus. */
function widgetsOf(state: EditorState): WidgetType[] {
  return buildMathDecorations(state, false).map((range) => {
    const widget: WidgetType | undefined = range.value.spec.widget;
    if (widget === undefined) throw new Error("A formula drew no widget.");
    return widget;
  });
}

/** Resolves once the microtasks queued before it have run. */
function microtasks(): Promise<void> {
  return Promise.resolve();
}

/** The formulas `doc` parses to, each as its node name and text. */
function formulasIn(doc: string): string[] {
  const state = createState(doc);
  const found: string[] = [];
  ensureSyntaxTree(state, state.doc.length, 5000)!.iterate({
    enter(node) {
      if (node.name === "InlineMath" || node.name === "DisplayMath") {
        found.push(`${node.name} ${state.sliceDoc(node.from, node.to)}`);
      }
    },
  });
  return found;
}

/** The names of every node `doc` parses to. */
function nodeNamesIn(doc: string): Set<string> {
  const state = createState(doc);
  const names = new Set<string>();
  ensureSyntaxTree(state, state.doc.length, 5000)!.iterate({
    enter(node) {
      names.add(node.name);
    },
  });
  return names;
}

/** Each decoration as its range, and whether it is a widget or a block. */
function describeDecorations(state: EditorState, hasFocus: boolean) {
  return buildMathDecorations(state, hasFocus).map((range) => ({
    from: range.from,
    to: range.to,
    widget: range.value.spec.widget !== undefined,
    block: range.value.spec.block === true,
    class: range.value.spec.class,
  }));
}

describe("prose-math", () => {
  afterEach(closeViews);

  describe("mathMarkdown", () => {
    it("parses `$…$` as an inline formula", () => {
      expect(formulasIn("Euler: $e^{i\\pi} + 1 = 0$.")).toEqual([
        "InlineMath $e^{i\\pi} + 1 = 0$",
      ]);
    });

    it("parses `$$…$$` across the lines of a paragraph as a display formula", () => {
      expect(formulasIn("$$\n\\int_0^1 x\\,dx\n$$")).toEqual([
        "DisplayMath $$\n\\int_0^1 x\\,dx\n$$",
      ]);
    });

    it("parses a `$$` formula inside a sentence", () => {
      expect(formulasIn("So $$x = 1$$ holds.")).toEqual([
        "DisplayMath $$x = 1$$",
      ]);
    });

    it("leaves dollar amounts as text", () => {
      expect(formulasIn("It costs $5 and $6.")).toEqual([]);
    });

    it("leaves a dollar sign with a space after it as text", () => {
      expect(formulasIn("Pay $ 5 or $x $.")).toEqual([]);
    });

    it("leaves an escaped dollar sign as text", () => {
      expect(formulasIn("A \\$x$ sign.")).toEqual([]);
    });

    it("leaves a `$$` that nothing closes before a blank line as text", () => {
      expect(formulasIn("$$\n\\alpha\n\nA paragraph $b$.")).toEqual([
        "InlineMath $b$",
      ]);
    });

    it("parses no emphasis inside a formula", () => {
      const names = nodeNamesIn("$a*b*c$");
      expect(names.has("InlineMath")).toBe(true);
      expect(names.has("Emphasis")).toBe(false);
    });

    it("parses no formula inside code", () => {
      expect(formulasIn("`$x$`\n\n```\n$$\ny\n$$\n```")).toEqual([]);
    });
  });

  describe("buildMathDecorations", () => {
    it("replaces an inline formula with a widget while the editor has no focus", () => {
      const state = createState("Euler $e^x$ here", 8);
      expect(describeDecorations(state, false)).toEqual([
        { from: 6, to: 11, widget: true, block: false, class: undefined },
      ]);
    });

    it("keeps the TeX of a formula the cursor touches, marked as source", () => {
      const state = createState("Euler $e^x$ here", 8);
      expect(describeDecorations(state, true)).toEqual([
        {
          from: 6,
          to: 11,
          widget: false,
          block: false,
          class: "cm-prose-math-source",
        },
      ]);
    });

    it("replaces a formula the cursor is away from", () => {
      const state = createState("Euler $e^x$ here", 15);
      expect(describeDecorations(state, true)).toEqual([
        { from: 6, to: 11, widget: true, block: false, class: undefined },
      ]);
    });

    it("replaces the whole lines of a `$$` formula with a block widget", () => {
      const doc = "Before\n\n$$\n\\int x\n$$\n\nAfter";
      const state = createState(doc, doc.length);
      expect(describeDecorations(state, true)).toEqual([
        { from: 8, to: 20, widget: true, block: true, class: undefined },
      ]);
    });

    it("keeps the TeX of a block formula while the cursor is on any of its lines", () => {
      const doc = "Before\n\n$$\n\\int x\n$$\n\nAfter";
      const state = createState(doc, doc.indexOf("\\int") + 2);
      expect(describeDecorations(state, true)).toEqual([
        {
          from: 8,
          to: 20,
          widget: false,
          block: false,
          class: "cm-prose-math-source",
        },
      ]);
    });

    it("draws a `$$` formula inside a sentence inline", () => {
      const state = createState("So $$x$$ holds.", 0);
      expect(describeDecorations(state, false)).toEqual([
        { from: 3, to: 8, widget: true, block: false, class: undefined },
      ]);
    });

    it("draws no formula with nothing between its delimiters", () => {
      expect(describeDecorations(createState("Empty $$ $$ here"), false))
        .toEqual([]);
    });
  });

  describe("MathWidget", () => {
    it("draws a formula as what no renderer draws when the state has none", () => {
      const [widget] = widgetsOf(createState("Euler $e^x$ here", 0));
      const view = openView("", 0, []);
      const element = widget.toDOM(view);
      expect(element.textContent).toBe("$e^x$");
      expect(element.title).toBe("No renderer draws formulas here.");
      expect(element.className).toBe("cm-prose-math cm-prose-math-error");
    });

    it("is equal to a widget for the same formula, drawn the same way", () => {
      const [a, b] = widgetsOf(createState("$x$ and $x$"));
      expect(a.eq(b)).toBe(true);
    });

    it("differs from a widget for other TeX, style or layout", () => {
      const [inline, other, display, block] = widgetsOf(
        createState("$x$ and $y$ and $$x$$\n\n$$\nx\n$$"),
      );
      expect(inline.eq(other)).toBe(false);
      expect(inline.eq(display)).toBe(false);
      expect(display.eq(block)).toBe(false);
    });

    it("lets the editor handle events on the formula", () => {
      const [widget] = widgetsOf(createState("$x$"));
      expect(widget.ignoreEvent(new MouseEvent("mousedown"))).toBe(
        false,
      );
    });
  });

  describe("proseMath", () => {
    it("draws an inline formula with the renderer, in place of its TeX", () => {
      const { calls, render } = recordingRenderer();
      const view = openView("Euler $e^x$ here", 0, proseMath(false, render));
      expect(textsOf(view, "span.cm-prose-math")).toEqual(["e^x"]);
      expect(view.contentDOM.querySelector(".cm-prose-math b")).not.toBeNull();
      expect(view.contentDOM.textContent).toBe("Euler e^x here");
      expect(calls).toEqual(["inline e^x"]);
    });

    it("draws a `$$` formula with its lines to itself as a display block", () => {
      const { calls, render } = recordingRenderer();
      const view = openView(
        "Before\n\n$$\n\\int x\n$$\n\nAfter",
        0,
        proseMath(false, render),
      );
      expect(textsOf(view, "div.cm-prose-math-block")).toEqual([
        "\\int x (display)",
      ]);
      expect(textsOf(view, "span.cm-prose-math")).toEqual([]);
      expect(calls).toEqual(["display \\int x"]);
    });

    it("shows TeX the renderer refuses as written, with its message as the title", () => {
      const view = openView(
        "So $$\\frac{1$$ and $x$.",
        0,
        proseMath(false, (tex) => ({ error: `Cannot set ${tex}` })),
      );
      const errors = Array.from(
        view.contentDOM.querySelectorAll<HTMLElement>(".cm-prose-math-error"),
        (element) => [element.textContent, element.title],
      );
      expect(errors).toEqual([
        ["$$\\frac{1$$", "Cannot set \\frac{1"],
        ["$x$", "Cannot set x"],
      ]);
    });

    it("leaves a container's markup out of the TeX of a formula running over its lines", () => {
      const { calls, render } = recordingRenderer();
      openView("> $$\n> a +\n> b\n> $$\n\nEnd", 0, proseMath(false, render));
      // Each `>` is left out, and the space after it is TeX's to ignore.
      expect(calls).toEqual(["display a +\n b"]);
    });

    it("keeps the TeX of the formula the cursor is in once the editor has focus", async () => {
      const { render } = recordingRenderer();
      const view = openView("Euler $e^x$ here", 8, proseMath(false, render));
      expect(textsOf(view, ".cm-prose-math-source")).toEqual([]);
      view.focus();
      view.dispatch({ selection: { anchor: 8 } });
      await microtasks();
      expect(textsOf(view, ".cm-prose-math-source")).toEqual(["$e^x$"]);
      expect(textsOf(view, ".cm-prose-math")).toEqual([]);
    });

    it("draws the formula again once the editor loses focus", async () => {
      const time = new FakeTime();
      try {
        const { render } = recordingRenderer();
        const view = openView("Euler $e^x$ here", 8, proseMath(false, render));
        view.focus();
        view.dispatch({ selection: { anchor: 8 } });
        await microtasks();
        expect(textsOf(view, ".cm-prose-math-source")).toEqual(["$e^x$"]);

        // CodeMirror notices a blur a few milliseconds after the event.
        view.contentDOM.blur();
        time.tick(50);
        await microtasks();
        expect(textsOf(view, ".cm-prose-math-source")).toEqual([]);
        expect(textsOf(view, ".cm-prose-math")).toEqual(["e^x"]);
      } finally {
        time.restore();
      }
    });

    it("draws as focused from the start when told the view has focus", async () => {
      const { render } = recordingRenderer();
      const view = openView("Euler $e^x$ here", 8, proseMath(true, render));
      expect(textsOf(view, ".cm-prose-math-source")).toEqual(["$e^x$"]);
      // The view has no focus, so the extension corrects itself.
      await microtasks();
      expect(textsOf(view, ".cm-prose-math-source")).toEqual([]);
      expect(textsOf(view, ".cm-prose-math")).toEqual(["e^x"]);
    });

    it("sends no correction to a view destroyed before it goes out", async () => {
      const { render } = recordingRenderer();
      const sent: Transaction[] = [];
      openView("$x$", 0, proseMath(true, render), sent);
      await microtasks();
      expect(sent).toHaveLength(1);

      const dropped: Transaction[] = [];
      openView("$x$", 0, proseMath(true, render), dropped).destroy();
      await microtasks();
      expect(dropped).toEqual([]);
    });

    it("draws a formula once, however the selection moves while unfocused", () => {
      const { calls, render } = recordingRenderer();
      const view = openView("Euler $e^x$ here", 0, proseMath(false, render));
      const drawn = view.contentDOM.querySelector(".cm-prose-math");
      view.dispatch({ selection: { anchor: 8 } });
      view.dispatch({});
      expect(view.contentDOM.querySelector(".cm-prose-math")).toBe(drawn);
      expect(calls).toEqual(["inline e^x"]);
    });

    it("draws a formula again when its TeX changes", () => {
      const { calls, render } = recordingRenderer();
      const view = openView("Euler $e^x$ here", 0, proseMath(false, render));
      view.dispatch({ changes: { from: 10, insert: "+1" } });
      expect(textsOf(view, ".cm-prose-math")).toEqual(["e^x+1"]);
      expect(calls).toEqual(["inline e^x", "inline e^x+1"]);
    });

    it("draws every formula again with a renderer it is reconfigured with", () => {
      const first = recordingRenderer("first ");
      const second = recordingRenderer("second ");
      const math = new Compartment();
      const view = openView(
        "Euler $e^x$ here",
        0,
        math.of(proseMath(false, first.render)),
      );
      expect(textsOf(view, ".cm-prose-math")).toEqual(["first e^x"]);
      view.dispatch({
        effects: math.reconfigure(proseMath(false, second.render)),
      });
      expect(textsOf(view, ".cm-prose-math")).toEqual(["second e^x"]);
    });
  });
});
