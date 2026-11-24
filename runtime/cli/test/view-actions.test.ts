import { assert, assertEquals } from "@std/assert";
import { parseDocument, SAMPLE } from "./view-helpers.ts";
import type { Document, StructureNode } from "../lib/view/model.ts";
import {
  clamp,
  findMatches,
  frameTop,
  maxPagerTop,
  maxTop,
  nextMatchIndex,
  nodeAtLine,
  nodeForViewport,
  scrollToAnchor,
  treeChild,
  treeNextSibling,
  treeParent,
  treePreOrderNext,
  treePreOrderPrev,
  treePrevSibling,
} from "../lib/view/actions.ts";

/** Minimal structure node with just the depth the navigation helpers read. */
function node(depth: number, label = ""): StructureNode {
  return {
    kind: "variable",
    label,
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 0,
    startOffset: 0,
    endOffset: 0,
    depth,
    children: [],
  };
}

Deno.test("clamp / maxTop", () => {
  assertEquals(clamp(5, 0, 3), 3);
  assertEquals(clamp(-1, 0, 3), 0);
  assertEquals(clamp(2, 0, 3), 2);
  // 100 lines, height 24 -> content rows 23 -> maxTop 77
  assertEquals(maxTop(100, 24), 77);
  assertEquals(maxTop(5, 24), 0);
});

Deno.test("maxPagerTop leaves the bottom three quarters below the last line", () => {
  // Height 21 has 20 content rows. The last line occupies the fifth row, with
  // 15 rows below it.
  assertEquals(maxPagerTop(100, 21), 95);
  assertEquals(maxPagerTop(5, 21), 0, "a short document already fits");
  assertEquals(maxPagerTop(100, 2), 99, "one content row still shows text");
});

Deno.test("findMatches: smartcase", () => {
  const doc = parseDocument(SAMPLE);
  // lower-case query is case-insensitive
  const lower = findMatches(doc, "token");
  assert(
    lower.length >= 3,
    `expected several token matches, got ${lower.length}`,
  );
  // mixed/upper query is case-sensitive: `Token` should not match `token`
  const upper = findMatches(doc, "Token");
  assertEquals(upper.length, 0);
  // each match span is the query length
  for (const m of lower) assertEquals(m.end - m.start, 5);
});

Deno.test("findMatches: empty query returns nothing", () => {
  const doc = parseDocument(SAMPLE);
  assertEquals(findMatches(doc, "").length, 0);
});

/** A document whose lines are exactly `texts`, with no spans/structure. Enough
 * for `findMatches`, which only reads each line's `text`. */
function linesDoc(...texts: string[]): Document {
  return {
    text: texts.join("\n"),
    lines: texts.map((text) => ({ text, spans: [] })),
    structure: [],
    flatStructure: [],
    definitions: new Map(),
  };
}

Deno.test("findMatches: case-insensitive columns are in the original string", () => {
  // `İ` (U+0130) lowercases to two code units (`i` + combining dot above), so a
  // match after it must not be shifted by the extra folded unit. `foo` starts
  // at original code-point column 3 regardless of the fold length change.
  assertEquals(
    findMatches(linesDoc("İx foo"), "foo"),
    [{ line: 0, start: 3, end: 6 }],
  );
  // Two length-changing characters before the match still leave it at column 3.
  assertEquals(
    findMatches(linesDoc("İİ foo"), "foo"),
    [{ line: 0, start: 3, end: 6 }],
  );
  // A non-BMP character (one code point, two code units) counts as one column.
  assertEquals(
    findMatches(linesDoc("𝑻x bar"), "bar"),
    [{ line: 0, start: 3, end: 6 }],
  );
  // Matching the `i` that `İ` folds to highlights the single original column.
  assertEquals(
    findMatches(linesDoc("İx"), "i"),
    [{ line: 0, start: 0, end: 1 }],
  );
});

Deno.test("nextMatchIndex: forward, backward and wrap", () => {
  const matches = [
    { line: 2, start: 4, end: 8 },
    { line: 5, start: 0, end: 4 },
    { line: 9, start: 2, end: 6 },
  ];
  // forward from before everything
  assertEquals(nextMatchIndex(matches, 0, 0, true), 0);
  // forward from line 2 col 4 -> next is index 1
  assertEquals(nextMatchIndex(matches, 2, 4, true), 1);
  // forward past the end wraps to 0
  assertEquals(nextMatchIndex(matches, 9, 2, true), 0);
  // backward from the end
  assertEquals(nextMatchIndex(matches, 9, 2, false), 1);
  // backward before the start wraps to last
  assertEquals(nextMatchIndex(matches, 0, 0, false), 2);
  // no matches
  assertEquals(nextMatchIndex([], 0, 0, true), -1);
});

// Tree:  Z   A( A1( A1a, A1b ), A2 )   B( B1 )
function navTree() {
  return [
    node(0, "Z"), //   0
    node(0, "A"), //   1
    node(1, "A1"), //  2
    node(2, "A1a"), // 3
    node(2, "A1b"), // 4
    node(1, "A2"), //  5
    node(0, "B"), //   6
    node(1, "B1"), //  7
  ];
}

Deno.test("tree navigation: a parent, d first child", () => {
  const flat = navTree();
  assertEquals(treeParent(flat, 3), 2, "A1a -> A1");
  assertEquals(treeParent(flat, 2), 1, "A1 -> A");
  assertEquals(treeParent(flat, 7), 6, "B1 -> B");
  assertEquals(treeParent(flat, 1), 1, "A has no parent");

  assertEquals(treeChild(flat, 1), 2, "A -> A1");
  assertEquals(treeChild(flat, 2), 3, "A1 -> A1a");
  assertEquals(treeChild(flat, 3), 3, "A1a is a leaf");
  assertEquals(treeChild(flat, 5), 5, "A2 is a leaf");
});

Deno.test("tree navigation: w/s siblings, with s exiting and w going to parent", () => {
  const flat = navTree();
  // plain siblings
  assertEquals(treeNextSibling(flat, 3), 4, "A1a -> A1b");
  assertEquals(treePrevSibling(flat, 4), 3, "A1b -> A1a");
  assertEquals(treeNextSibling(flat, 1), 6, "A -> B (root siblings)");
  assertEquals(treePrevSibling(flat, 6), 1, "B -> A");

  // past the last child: `s` exits the parent, takes the parent's next sibling
  assertEquals(treeNextSibling(flat, 4), 5, "A1b (last) exits A1 -> A2");
  assertEquals(treeNextSibling(flat, 5), 6, "A2 (last) exits A -> B");

  // at the first child: `w` steps up to the parent node
  assertEquals(treePrevSibling(flat, 3), 2, "A1a (first) -> parent A1");
  assertEquals(treePrevSibling(flat, 7), 6, "B1 (first) -> parent B");

  // genuine ends are no-ops
  assertEquals(treeNextSibling(flat, 7), 7, "B1 is the very last node");
  assertEquals(treePrevSibling(flat, 0), 0, "Z is the very first node");
});

Deno.test("tree navigation: Tab/Shift-Tab are depth-first (pre-order)", () => {
  const flat = navTree();
  assertEquals(treePreOrderNext(flat, 1), 2, "A -> A1 (descends)");
  assertEquals(treePreOrderNext(flat, 4), 5, "A1b -> A2");
  assertEquals(treePreOrderNext(flat, 7), 7, "clamps at the end");
  assertEquals(treePreOrderPrev(flat, 2), 1, "A1 -> A");
  assertEquals(treePreOrderPrev(flat, 0), 0, "clamps at the start");
});

Deno.test("tree navigation: child's parent round-trips on the fixture", () => {
  const doc = parseDocument(SAMPLE);
  const flat = doc.flatStructure;
  assert(flat.length > 3);
  for (let i = 0; i < flat.length; i++) {
    const child = treeChild(flat, i);
    if (child !== i) {
      assertEquals(flat[child].depth, flat[i].depth + 1, "child is one deeper");
      assertEquals(treeParent(flat, child), i, "parent of first child is i");
    }
  }
});

Deno.test("nodeAtLine finds the innermost containing node", () => {
  const doc = parseDocument(SAMPLE);
  const liftIdx = doc.flatStructure.findIndex((n) =>
    n.label.startsWith("lift __cfLift_1")
  );
  assert(liftIdx >= 0);
  const lift = doc.flatStructure[liftIdx];
  // a line inside the lift's schema should resolve to a node nested in the lift
  const mid = Math.floor((lift.startLine + lift.endLine) / 2);
  const hit = nodeAtLine(doc.flatStructure, mid);
  assert(hit >= 0);
  const node = doc.flatStructure[hit];
  assert(
    node.startLine >= lift.startLine && node.endLine <= lift.endLine,
    "innermost node is within the lift",
  );
});

Deno.test("frameTop: centers a node that fits on screen", () => {
  // node lines 20–29 (height 10), height 40 -> contentRows 39 (fits)
  // centered: top = 20 - floor((39 - 10) / 2) = 20 - 14 = 6
  const top = frameTop(20, 29, 40, 1000);
  assertEquals(top, 6);
  // the node is fully visible and roughly centered
  const rows = 39;
  assert(20 >= top && 29 <= top + rows - 1, "whole node on screen");
  const above = 20 - top;
  const below = (top + rows - 1) - 29;
  assert(Math.abs(above - below) <= 1, "node roughly centered");
});

Deno.test("frameTop: puts a too-tall node's top line ~1/10 down", () => {
  // node lines 100–200 (height 101) > contentRows 39 -> top = 100 - floor(39/10)
  const top = frameTop(100, 200, 40, 1000);
  assertEquals(top, 100 - 3);
  assert(top < 100, "node start is below the top of the screen");
});

Deno.test("frameTop: respects document bounds", () => {
  assertEquals(frameTop(0, 2, 40, 1000), 0, "cannot scroll above the start");
  const t = frameTop(999, 999, 40, 1000);
  assertEquals(t, 980, "the padded end lets the final line be centered");
  assert(t <= maxPagerTop(1000, 40));
});

Deno.test("scrollToAnchor: no scroll when the anchor is already visible", () => {
  // height 12 -> contentRows 11 -> visible window [top, top+10]
  assertEquals(scrollToAnchor(15, 10, 12, 1000), 10); // mid-screen
  assertEquals(scrollToAnchor(10, 10, 12, 1000), 10); // top edge
  assertEquals(scrollToAnchor(20, 10, 12, 1000), 10); // bottom edge
});

Deno.test("scrollToAnchor: minimal scroll when the anchor is off screen", () => {
  // anchor above the viewport -> scroll up, anchor becomes visible
  const up = scrollToAnchor(5, 30, 12, 1000);
  assert(up < 30, "scrolled up");
  assert(5 >= up && 5 <= up + 10, "anchor now visible");
  // anchor below the viewport -> scroll down, anchor becomes visible
  const down = scrollToAnchor(60, 10, 12, 1000);
  assert(down > 10, "scrolled down");
  assert(60 >= down && 60 <= down + 10, "anchor now visible");
});

Deno.test("scrollToAnchor: respects document bounds", () => {
  assertEquals(scrollToAnchor(0, 50, 12, 1000), 0); // can't scroll past the top
  // The padded end leaves room for the normal lower margin around the anchor.
  const t = scrollToAnchor(999, 0, 12, 1000);
  assertEquals(t, 991);
  assert(t <= maxPagerTop(1000, 12));
  assert(999 >= t && 999 <= t + 10, "last-line anchor visible");
});

Deno.test("nodeForViewport: prefers the first node whose anchor is on screen", () => {
  const doc = parseDocument(SAMPLE);
  // From the top with a tall viewport, the very first node is chosen.
  const idx0 = nodeForViewport(doc.flatStructure, 0, 50);
  assertEquals(idx0, 0);
  assertEquals(doc.flatStructure[idx0].startLine, 0);
  // Scrolled down: choose the topmost node that actually starts on screen.
  const top = 20;
  const rows = 6; // height 7 -> visible [20,25]
  const idx = nodeForViewport(doc.flatStructure, top, rows + 1);
  const node = doc.flatStructure[idx];
  const anyVisible = doc.flatStructure.some(
    (n) => n.startLine >= top && n.startLine <= top + rows - 1,
  );
  if (anyVisible) {
    assert(
      node.startLine >= top && node.startLine <= top + rows - 1,
      `chosen anchor ${node.startLine} on screen`,
    );
  }
});
