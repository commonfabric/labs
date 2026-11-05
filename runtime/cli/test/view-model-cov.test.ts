/**
 * The shared model's one runtime helper: flattenStructure turns a structure
 * tree into the pre-order sequence that `flatStructure` holds. It is exercised
 * by every parse/markdown/diff document build; this pins its behavior directly.
 */

import { assertEquals } from "@std/assert";
import { flattenStructure, type StructureNode } from "../lib/view/model.ts";

function node(label: string, children: StructureNode[] = []): StructureNode {
  return {
    kind: "node",
    label,
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 0,
    startOffset: 0,
    endOffset: 0,
    depth: 0,
    children,
  };
}

Deno.test("flattenStructure: pre-order, depth-first", () => {
  const tree = [
    node("a", [node("b", [node("c")]), node("d")]),
    node("e"),
  ];
  assertEquals(
    flattenStructure(tree).map((n) => n.label),
    ["a", "b", "c", "d", "e"],
  );
});

Deno.test("flattenStructure: an empty forest flattens to nothing", () => {
  assertEquals(flattenStructure([]), []);
});
