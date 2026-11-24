import { assert, assertEquals } from "@std/assert";
import type { StructureNode } from "../lib/view/model.ts";
import {
  nodeAtLine,
  nodeForViewport,
  treeChild,
  treeNextSibling,
  treePrevSibling,
} from "../lib/view/actions.ts";

/** Minimal structure node carrying just the fields the helpers read. */
function node(
  depth: number,
  startLine = 0,
  endLine = 0,
  label = "",
): StructureNode {
  return {
    kind: "variable",
    label,
    startLine,
    endLine,
    startCol: 0,
    endCol: 0,
    startOffset: 0,
    endOffset: 0,
    depth,
    children: [],
  };
}

Deno.test("treeNextSibling: out-of-range index is a no-op (line 96)", () => {
  const flat = [node(0), node(1), node(1)];
  // An index past the end never enters the while loop, so the function
  // returns the index unchanged via the final fallthrough.
  assertEquals(treeNextSibling(flat, flat.length), flat.length);
  assertEquals(treeNextSibling(flat, 99), 99);
  // A negative index likewise fails the `cur >= 0` guard immediately.
  assertEquals(treeNextSibling(flat, -1), -1);
  // The empty list also exits without entering the loop body.
  assertEquals(treeNextSibling([], 0), 0);
});

Deno.test("treePrevSibling: undefined node returns the index (line 109)", () => {
  const flat = [node(0), node(1)];
  // `flat[idx]` is undefined for an out-of-range index, so the guard returns
  // the index unchanged before scanning.
  assertEquals(treePrevSibling(flat, flat.length), flat.length);
  assertEquals(treePrevSibling(flat, 42), 42);
  assertEquals(treePrevSibling([], 0), 0);
});

Deno.test("treeChild: undefined node returns the index (line 148)", () => {
  const flat = [node(0), node(1)];
  // Same guard: an out-of-range index has no node, so `treeChild` is a no-op.
  assertEquals(treeChild(flat, flat.length), flat.length);
  assertEquals(treeChild(flat, 7), 7);
  assertEquals(treeChild([], 0), 0);
});

Deno.test(
  "nodeForViewport: falls back to the enclosing node when nothing starts on screen (lines 231-232)",
  () => {
    // One outer node spanning lines 0..100 and an inner node that *starts*
    // above the viewport. With the viewport at [50,55], no node's startLine is
    // on screen, so the loop never returns and the enclosing-node fallback runs.
    const flat = [
      node(0, 0, 100, "outer"), // startLine 0, encloses line 50
      node(1, 10, 100, "inner"), // startLine 10, also encloses line 50
    ];
    const top = 50;
    const height = 7; // rows = 6 -> visible window [50, 55]
    // Sanity check: no node starts inside the visible window.
    const anyOnScreen = flat.some(
      (n) => n.startLine >= top && n.startLine <= top + 5,
    );
    assert(!anyOnScreen, "no node anchor is on screen for this fixture");
    // nodeAtLine picks the innermost enclosing node (smallest span): the inner.
    assertEquals(nodeAtLine(flat, top), 1);
    assertEquals(nodeForViewport(flat, top, height), 1);
  },
);

Deno.test(
  "nodeForViewport: falls back to 0 when nothing starts on screen and nothing encloses (line 232 else)",
  () => {
    // Every node lives entirely above the viewport, so neither the on-screen
    // scan nor nodeAtLine matches; the fallback returns 0.
    const flat = [
      node(0, 0, 5, "a"),
      node(0, 6, 10, "b"),
    ];
    const top = 50;
    const height = 7; // visible window [50, 55]
    assertEquals(nodeAtLine(flat, top), -1, "nothing encloses line 50");
    assertEquals(nodeForViewport(flat, top, height), 0);
  },
);
