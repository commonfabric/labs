import { assert } from "@std/assert";
import { parseDocument } from "./view-helpers.ts";
import { buildPeekCard } from "../lib/view/card.ts";
import type { Document, Line, StructureNode } from "../lib/view/model.ts";

function infoText(doc: Document, node: StructureNode): string {
  const card = buildPeekCard(doc, node);
  return card.info.map((line: Line) => line.spans.map((s) => s.text).join(""))
    .join("\n");
}

Deno.test("card: a comment child is hoisted through, never listed in the outline", () => {
  // Probe: try every way a `"comment"`-kind node could reach the outline's
  // `glyph(child.kind)` call. The outline hoists through node/comment children
  // rather than listing them, so a comment kind should never reach `glyph`.
  const comment: StructureNode = {
    kind: "comment",
    label: "# a standalone comment",
    startLine: 1,
    endLine: 1,
    startCol: 0,
    endCol: 20,
    startOffset: 10,
    endOffset: 30,
    depth: 1,
    children: [],
  };
  // A `"node"` wrapper that itself carries a comment child, to exercise the
  // recursion in outlineChildren on both node and comment kinds.
  const wrapper: StructureNode = {
    kind: "node",
    label: "wrapper",
    startLine: 2,
    endLine: 3,
    startCol: 0,
    endCol: 5,
    startOffset: 40,
    endOffset: 60,
    depth: 1,
    children: [{
      kind: "comment",
      label: "# nested comment",
      startLine: 2,
      endLine: 2,
      startCol: 2,
      endCol: 18,
      startOffset: 42,
      endOffset: 58,
      depth: 2,
      children: [],
    }],
  };
  // One real, listable child so the outline section renders at all.
  const fn: StructureNode = {
    kind: "function",
    label: "child_function",
    startLine: 4,
    endLine: 4,
    startCol: 0,
    endCol: 5,
    startOffset: 70,
    endOffset: 75,
    depth: 1,
    children: [],
  };
  const children = [comment, wrapper, fn];
  const parent: StructureNode = {
    kind: "function",
    label: "parent",
    startLine: 0,
    endLine: 5,
    startCol: 0,
    endCol: 6,
    startOffset: 0,
    endOffset: 999,
    depth: 0,
    children,
  };
  const flat = [parent, ...children, ...wrapper.children];
  const lines: Line[] = Array.from(
    { length: 6 },
    () => ({ text: "", spans: [] }),
  );
  const doc: Document = {
    text: "\n".repeat(6),
    lines,
    structure: [parent],
    flatStructure: flat,
    definitions: new Map(),
  };
  const text = infoText(doc, parent);
  // Only the function child is listed; the two comment nodes are hoisted
  // through (the node wrapper contributes nothing once its only child is a
  // comment). So the outline counts exactly one child.
  assert(text.includes("OUTLINE · 1"), `lists one child: ${text}`);
  assert(text.includes("ƒ"), "function glyph present");
  // The comment glyph `#` is never produced from the outline: comment nodes do
  // not survive outlineChildren's filter.
  assert(!text.includes("# nested comment"), "nested comment not listed");
});

Deno.test("card: real source comments stay out of the outline glyph list", () => {
  // Drive a parsed document with real comments to confirm the same behavior on
  // the production parse path: comments thread in as their own nodes but the
  // outline never lists them with a glyph.
  const src = `// transformed: /app.ts
// a leading comment
function alpha() {
  // an inner comment
  return 1;
}
// a trailing comment
function beta() {
  return 2;
}
`;
  const doc = parseDocument(src);
  const section = doc.flatStructure.find((n) => n.kind === "section")!;
  const text = infoText(doc, section);
  // The outline lists the two functions, picking the function glyph for each.
  assert(text.includes("ƒ"), `function glyph present: ${text}`);
  assert(text.includes("alpha"), `alpha listed: ${text}`);
  assert(text.includes("beta"), `beta listed: ${text}`);
});
