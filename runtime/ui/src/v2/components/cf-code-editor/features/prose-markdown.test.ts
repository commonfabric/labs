import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { Decoration } from "@codemirror/view";
import { buildProseDecorations } from "./prose-markdown.ts";

//
// Helpers
//

/** Create a headless EditorState with markdown+GFM parsing and a cursor position. */
function createState(doc: string, cursor = 0): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ extensions: GFM })],
    selection: { anchor: cursor },
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

type DecoRange = ReturnType<typeof buildProseDecorations>[number];

/** True when `decos` contains a replace decoration spanning `[from, to)`. */
function hasReplace(decos: DecoRange[], from: number, to: number): boolean {
  return decos.some(
    (d) => d.from === from && d.to === to && isReplace(d.value),
  );
}

/** True when `decos` contains a mark decoration spanning `[from, to)` with the given CSS class. */
function hasMark(
  decos: DecoRange[],
  from: number,
  to: number,
  className: string,
): boolean {
  return decos.some(
    (d) =>
      d.from === from && d.to === to &&
      isMark(d.value) &&
      d.value.spec?.class === className,
  );
}

/** True when `decos` contains a widget decoration spanning `[from, to)`. */
function hasWidget(decos: DecoRange[], from: number, to: number): boolean {
  return decos.some(
    (d) => d.from === from && d.to === to && d.value.spec?.widget,
  );
}

/** True when `decos` contains a line decoration at `from` whose class includes `cls`. */
function hasLineClass(decos: DecoRange[], from: number, cls: string): boolean {
  return decos.some(
    (d) => d.from === from && d.value.spec?.class?.includes(cls),
  );
}

/** Identifies a replace (or widget) decoration. Replace decorations have no `class` in their spec. */
function isReplace(deco: Decoration): boolean {
  return !("class" in (deco.spec ?? {}));
}

/** Identifies a mark decoration. Mark decorations always carry a `class` string in their spec. */
function isMark(deco: Decoration): boolean {
  return typeof deco.spec?.class === "string";
}

//
// Tests
//

describe("buildProseDecorations", () => {
  it("returns empty array for empty document", () => {
    const decos = buildProseDecorations(createState(""), true);
    expect(decos).toEqual([]);
  });

  it("hides all markers when hasFocus is false, even with cursor on line", () => {
    const state = createState("# Hello", 0);
    const decos = buildProseDecorations(state, false);
    expect(hasReplace(decos, 0, 2)).toBe(true);
  });

  describe("headings", () => {
    it("hides markers when inactive and reveals when cursor is on line", () => {
      // Cursor elsewhere: markers hidden, mark on text only
      const far = createState("# Hello\nother", 10);
      const farDecos = buildProseDecorations(far, true);
      expect(hasReplace(farDecos, 0, 2)).toBe(true);
      expect(hasMark(farDecos, 2, 7, "cm-prose-h1")).toBe(true);

      // Cursor on heading line: markers visible, mark includes markers
      const near = createState("# Hello", 3);
      const nearDecos = buildProseDecorations(near, true);
      expect(hasReplace(nearDecos, 0, 2)).toBe(false);
      expect(hasMark(nearDecos, 0, 7, "cm-prose-h1")).toBe(true);
    });

    for (let level = 1; level <= 6; level++) {
      for (const suffix of ["", " ", "  ", " #"]) {
        it(`handles an unfinished level ${level} heading with suffix ${JSON.stringify(suffix)}`, () => {
          const doc = `# Existing heading\n\n${"#".repeat(level)}${suffix}`;
          const state = createState(doc);
          const decos = buildProseDecorations(state, false);
          expect(hasMark(decos, 2, 18, "cm-prose-h1")).toBe(true);
          expect(() => Decoration.set(decos, true)).not.toThrow();
        });
      }
    }

    it("maps heading levels to correct CSS classes", () => {
      const state = createState("## Second\n### Third", 18);
      const decos = buildProseDecorations(state, true);
      expect(hasMark(decos, 3, 9, "cm-prose-h2")).toBe(true);
      expect(hasMark(decos, 10, 19, "cm-prose-h3")).toBe(true);
    });
  });

  describe("inline syntax (bold, italic, strikethrough)", () => {
    // These share the INLINE_SYNTAX code path — test all entries together
    const cases: [string, number, number, number, number, string][] = [
      ["**bold**\nnext", 0, 2, 6, 8, "cm-prose-bold"],
      ["*italic*\nnext", 0, 1, 7, 8, "cm-prose-italic"],
      ["~~struck~~\nnext", 0, 2, 8, 10, "cm-prose-strikethrough"],
    ];

    for (const [input, oFrom, oTo, cFrom, cTo, cls] of cases) {
      it(`hides ${cls} markers when cursor is elsewhere`, () => {
        const state = createState(input, input.length - 1);
        const decos = buildProseDecorations(state, true);
        expect(hasReplace(decos, oFrom, oTo)).toBe(true);
        expect(hasReplace(decos, cFrom, cTo)).toBe(true);
        expect(hasMark(decos, 0, cTo, cls)).toBe(true);
      });
    }

    it("reveals markers when cursor is inside", () => {
      const state = createState("**bold**", 4);
      const decos = buildProseDecorations(state, true);
      expect(hasReplace(decos, 0, 2)).toBe(false);
      expect(hasReplace(decos, 6, 8)).toBe(false);
      expect(hasMark(decos, 0, 8, "cm-prose-bold")).toBe(true);
    });
  });

  describe("bullet lists", () => {
    it("replaces marker with widget when inactive, reveals when active", () => {
      // Cursor elsewhere: widget present
      const far = createState("- item\nnext", 8);
      expect(hasWidget(buildProseDecorations(far, true), 0, 2)).toBe(true);

      // Cursor on line: no widget
      const near = createState("- item", 3);
      expect(hasWidget(buildProseDecorations(near, true), 0, 2)).toBe(false);
    });
  });

  describe("ordered lists", () => {
    it("replaces number marker with widget when cursor is elsewhere", () => {
      const state = createState("1. first\nnext", 10);
      const decos = buildProseDecorations(state, true);
      const olDeco = decos.find(
        (d) => d.from === 0 && d.value.spec?.widget,
      );
      expect(olDeco).toBeDefined();
    });
  });

  describe("horizontal rules", () => {
    it("replaces --- with HR widget when cursor is elsewhere", () => {
      const state = createState("---\nnext", 5);
      expect(hasWidget(buildProseDecorations(state, true), 0, 3)).toBe(true);
    });
  });

  describe("links", () => {
    it("hides brackets and URL when cursor is elsewhere", () => {
      const state = createState("[text](url)\nnext", 14);
      const decos = buildProseDecorations(state, true);

      // Opening [ hidden
      expect(hasReplace(decos, 0, 1)).toBe(true);
      // ](url) hidden
      const closingReplace = decos.find(
        (d) => d.from === 5 && isReplace(d.value),
      );
      expect(closingReplace).toBeDefined();
      expect(hasMark(decos, 0, 11, "cm-prose-link")).toBe(true);
    });

    it("reveals full syntax when cursor is inside", () => {
      const state = createState("[text](url)", 3);
      const decos = buildProseDecorations(state, true);
      expect(hasReplace(decos, 0, 1)).toBe(false);
      expect(hasMark(decos, 0, 11, "cm-prose-link")).toBe(true);
    });
  });

  describe("footnotes", () => {
    it("replaces [^label] with footnote widget when cursor is elsewhere", () => {
      const state = createState("text [^1] more\nnext", 17);
      const decos = buildProseDecorations(state, true);

      // Should have a widget for the footnote, not a regular link decoration
      const footnoteDeco = decos.find(
        (d) => d.value.spec?.widget && d.from === 5,
      );
      expect(footnoteDeco).toBeDefined();
      // Should NOT have a link mark (footnotes return early before link logic)
      expect(hasMark(decos, 5, 9, "cm-prose-link")).toBe(false);
    });
  });

  describe("inline code", () => {
    it("hides backticks and narrows mark when cursor is elsewhere", () => {
      const state = createState("`code`\nnext", 8);
      const decos = buildProseDecorations(state, true);
      expect(hasReplace(decos, 0, 1)).toBe(true);
      expect(hasReplace(decos, 5, 6)).toBe(true);
      // Mark on content only (between backticks)
      expect(hasMark(decos, 1, 5, "cm-prose-inline-code")).toBe(true);
    });

    it("shows backticks and expands mark to full range when cursor is inside", () => {
      const state = createState("`code`", 3);
      const decos = buildProseDecorations(state, true);
      // Backticks should NOT be hidden
      expect(hasReplace(decos, 0, 1)).toBe(false);
      expect(hasReplace(decos, 5, 6)).toBe(false);
      // Mark covers full range including backticks
      expect(hasMark(decos, 0, 6, "cm-prose-inline-code")).toBe(true);
    });
  });

  describe("blockquotes", () => {
    it("hides > marker when inactive but always applies line decoration", () => {
      // Cursor elsewhere: marker hidden, line class present
      const far = createState("> quote\nnext", 10);
      const farDecos = buildProseDecorations(far, true);
      expect(hasReplace(farDecos, 0, 2)).toBe(true);
      expect(hasLineClass(farDecos, 0, "cm-prose-blockquote")).toBe(true);

      // Cursor on line: marker visible, line class still present
      const near = createState("> quote", 3);
      const nearDecos = buildProseDecorations(near, true);
      expect(hasReplace(nearDecos, 0, 2)).toBe(false);
      expect(hasLineClass(nearDecos, 0, "cm-prose-blockquote")).toBe(true);
    });
  });

  describe("fenced code blocks", () => {
    it("hides fences and applies codeblock class when cursor is elsewhere", () => {
      const doc = "```js\nconsole.log(1)\n```\nnext";
      const state = createState(doc, doc.length - 1);
      const decos = buildProseDecorations(state, true);

      // Opening fence hidden (0-5), closing fence hidden (21-24)
      const openFence = decos.find((d) => d.from === 0 && d.to === 5);
      expect(openFence).toBeDefined();
      const closeFence = decos.find((d) => d.from === 21 && d.to === 24);
      expect(closeFence).toBeDefined();
      // Code line has codeblock class
      expect(hasLineClass(decos, 6, "cm-prose-codeblock")).toBe(true);
    });

    it("reveals fences when cursor is inside the block", () => {
      const doc = "```js\nconsole.log(1)\n```\nnext";
      const state = createState(doc, 8);
      const decos = buildProseDecorations(state, true);
      const openFence = decos.find((d) => d.from === 0 && d.to === 5);
      expect(openFence).toBeUndefined();
    });
  });

  describe("indented code blocks", () => {
    it("applies codeblock line class without cursor sensitivity", () => {
      // 4-space indented code is always styled, regardless of cursor position
      const doc = "    indented code\nnext";
      const state = createState(doc, 5); // cursor inside the code block
      const decos = buildProseDecorations(state, true);
      expect(hasLineClass(decos, 0, "cm-prose-codeblock")).toBe(true);
    });
  });

  describe("task checkboxes (GFM)", () => {
    it("replaces [ ] with checkbox widget when cursor is elsewhere", () => {
      const state = createState("- [ ] todo\nnext", 13);
      const decos = buildProseDecorations(state, true);
      const taskDeco = decos.find(
        (d) => d.value.spec?.widget && d.from >= 2 && d.from <= 3,
      );
      expect(taskDeco).toBeDefined();
    });

    it("applies strikethrough to checked task text", () => {
      const state = createState("- [x] done\nnext", 13);
      const decos = buildProseDecorations(state, true);
      const checkedMark = decos.find(
        (d) => d.value.spec?.class === "cm-prose-task-checked",
      );
      expect(checkedMark).toBeDefined();
    });
  });

  describe("tables (GFM)", () => {
    it("applies header, separator, and row decorations when cursor is elsewhere", () => {
      const doc = "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nnext";
      const state = createState(doc, doc.length - 1);
      const decos = buildProseDecorations(state, true);

      expect(hasLineClass(decos, 0, "cm-prose-table-header")).toBe(true);
      expect(hasLineClass(decos, 10, "cm-prose-table-separator")).toBe(true);
      // Data row — class is exactly "cm-prose-table-row" without "header"
      const rowDeco = decos.find(
        (d) =>
          d.value.spec?.class === "cm-prose-table-row" &&
          !d.value.spec?.class?.includes("header"),
      );
      expect(rowDeco).toBeDefined();
    });

    it("reveals raw table syntax when cursor is inside", () => {
      const doc = "| A | B |\n| --- | --- |\n| 1 | 2 |";
      const state = createState(doc, 3);
      const decos = buildProseDecorations(state, true);
      expect(hasLineClass(decos, 0, "cm-prose-table-header")).toBe(false);
    });
  });
});
