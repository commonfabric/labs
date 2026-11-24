import { assert, assertEquals } from "@std/assert";
import { parseDocument } from "./view-helpers.ts";
import { renderFrame, type ViewState } from "../lib/view/render.ts";
import { stripAnsi } from "../lib/view/ansi.ts";
import type { StructureNode } from "../lib/view/model.ts";

function baseView(over: Partial<ViewState> = {}): ViewState {
  return {
    top: 0,
    left: 0,
    width: 50,
    height: 10,
    color: true,
    showLineNumbers: false,
    wrapMode: "off",
    displayMode: "pictures",
    selected: null,
    matches: null,
    currentMatch: 0,
    message: "",
    inputLine: null,
    overlay: null,
    ...over,
  };
}

const ln = (text: string) => ({
  text,
  spans: [{ col: 0, text, cls: "plain" as const }],
});

/** A multi-line document with one selectable node spanning a sub-range, so the
 * guide rail draws its full set of glyphs (top corner, body, bottom corner) on
 * the node's lines and a blank guide on the lines outside it. */
function docWithNode(node: StructureNode) {
  return {
    text: "a\nb\nc\nd\ne\n",
    lines: [ln("a"), ln("b"), ln("c"), ln("d"), ln("e")],
    structure: [node],
    flatStructure: [node],
    definitions: new Map(),
  };
}

function mkNode(over: Partial<StructureNode> = {}): StructureNode {
  return {
    kind: "node",
    label: "n",
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 1,
    startOffset: 0,
    endOffset: 1,
    depth: 0,
    children: [],
    ...over,
  };
}

//
// The guide column (`guideChar`) is only drawn when a node is selected. With no
// gutter, the glyph sits at visible column 0 of each row. These tests drive
// every reachable branch of `guideChar`.
//

Deno.test("guide: a multi-line node draws top corner, body, and bottom corner", () => {
  // Node covers lines 1..3 of a five-line document. Lines 0 and 4 are outside
  // the node; line 1 is the start (╭), lines 2 are the body (│), line 3 is the
  // end (╰).
  const node = mkNode({ startLine: 1, endLine: 3 });
  const rows = renderFrame(
    docWithNode(node),
    baseView({ top: 0, selected: node, height: 6 }),
  );
  const col0 = rows.map((r) => stripAnsi(r)[0]);
  assertEquals(col0[0], " ", "blank guide above the node");
  assertEquals(col0[1], "╭", "top corner at the node's first line");
  assertEquals(col0[2], "│", "body rail inside the node");
  assertEquals(col0[3], "╰", "bottom corner at the node's last line");
  assertEquals(col0[4], " ", "blank guide below the node");
});

Deno.test("guide: a single-line node draws the arrow glyph", () => {
  // startLine === endLine -> the `▶` branch.
  const node = mkNode({ startLine: 2, endLine: 2 });
  const rows = renderFrame(
    docWithNode(node),
    baseView({ top: 0, selected: node, height: 6 }),
  );
  const col0 = rows.map((r) => stripAnsi(r)[0]);
  assertEquals(col0[2], "▶", "single-line node carries the arrow glyph");
  assertEquals(col0[1], " ", "blank guide above the single-line node");
  assertEquals(col0[3], " ", "blank guide below the single-line node");
});

Deno.test("guide: a node spanning two adjacent lines is all corners", () => {
  // startLine !== endLine, with no interior line -> top corner then bottom
  // corner, never the body rail.
  const node = mkNode({ startLine: 1, endLine: 2 });
  const rows = renderFrame(
    docWithNode(node),
    baseView({ top: 0, selected: node, height: 6 }),
  );
  const col0 = rows.map((r) => stripAnsi(r)[0]);
  assertEquals(col0[1], "╭", "first line is the top corner");
  assertEquals(col0[2], "╰", "second line is the bottom corner");
});

Deno.test("guide: lines past the end of the document still draw a blank rail", () => {
  // A short document with a single-line node and a tall view forces the
  // renderer to draw rows for line indices past the document, exercising the
  // out-of-range branch (lineIdx > endLine) of the guide character.
  const node = mkNode({ startLine: 0, endLine: 0 });
  const rows = renderFrame(
    docWithNode(node),
    baseView({ top: 0, selected: node, height: 9 }),
  );
  const col0 = rows.map((r) => stripAnsi(r)[0]);
  assertEquals(col0[0], "▶", "single-line node glyph on its line");
  // Content rows beyond the document (indices 5..7) are outside the node range.
  for (let r = 1; r < rows.length - 1; r++) {
    assertEquals(col0[r], " ", `blank guide on row ${r}`);
  }
});

Deno.test("guide: a node on a real parsed document draws the rail", () => {
  // Mirror the existing suite's use of a parsed document: pick a node that
  // spans more than one line and assert the rail glyphs appear.
  const doc = parseDocument(
    "const myPattern = pattern((input) => {\n  return input;\n});\n",
  );
  const node = doc.flatStructure.find((n) => n.endLine > n.startLine);
  assert(node, "the sample has a multi-line node");
  const rows = renderFrame(
    doc,
    baseView({ top: node.startLine, selected: node, height: 12 }),
  );
  const joined = rows.map(stripAnsi).join("\n");
  assert(/[╭│╰▶]/.test(joined), "guide glyphs present when a node is selected");
});
