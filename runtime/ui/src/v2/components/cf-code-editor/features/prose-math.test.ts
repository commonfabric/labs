import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { GFM } from "@lezer/markdown";
import katex from "katex";

import { KATEX_STYLES_VERSION } from "./katex-styles.ts";
import { buildMathDecorations, mathMarkdown } from "./prose-math.ts";

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

  describe("katex-styles", () => {
    it("holds the stylesheet of the KaTeX release the editor imports", () => {
      expect(KATEX_STYLES_VERSION).toBe(katex.version);
    });
  });
});
