import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { UI } from "@commonfabric/runner";

import { renderPieceInspection } from "../commands/piece.ts";
import {
  formatSpaceMap,
  formatViewTree,
  MapFormat,
  type PieceConnectionMap,
  type PieceInspection,
} from "../lib/piece.ts";
import { safeStringify } from "../lib/render.ts";

/** An id long enough to be shortened: 8 characters, `...`, 8 characters. */
const LONG = "fid1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LONG_SHORT = "fid1:aaa...aaaaaaaa";

const vnode = (name: string, children: unknown[]) => ({
  type: "vnode",
  name,
  props: {},
  children,
});

describe("piece-formatting", () => {
  describe("formatSpaceMap()", () => {
    // A hub that two pieces read, read by a third, beside a piece with no
    // connections. One edge names a piece the map does not hold.
    const connections: PieceConnectionMap = new Map([
      ["lonely", { name: "Lonely", readingFrom: [], readBy: [] }],
      ["hub", {
        name: "Hub",
        readingFrom: ["source", LONG],
        readBy: ["reader"],
      }],
      ["source", { name: "Source", readingFrom: [], readBy: ["hub"] }],
      ["reader", { name: "Reader", readingFrom: ["hub"], readBy: [] }],
    ]);

    it("returns a placeholder line for an empty map", () => {
      expect(formatSpaceMap(new Map(), MapFormat.ASCII)).toBe(
        "No pieces found in space.",
      );
    });

    it("returns each piece with its edges, the most connected first", () => {
      expect(formatSpaceMap(connections, MapFormat.ASCII)).toBe(
        [
          "=== Piece Space Map ===",
          "",
          "📦 Hub [hub]",
          "  ← reads from:",
          "    • Source",
          `    • ${LONG_SHORT}`,
          "  → read by:",
          "    • Reader",
          "",
          "📦 Source [source]",
          "  → read by:",
          "    • Hub",
          "",
          "📦 Reader [reader]",
          "  ← reads from:",
          "    • Hub",
          "",
          "📦 Lonely [lonely]",
          "  (no connections)",
          "",
          "",
        ].join("\n"),
      );
    });

    it("returns a node per piece and an edge per read in DOT", () => {
      expect(formatSpaceMap(connections, MapFormat.DOT)).toBe(
        [
          "digraph PieceSpace {",
          "  rankdir=LR;",
          "  node [shape=box];",
          "",
          '  "lonely" [label="Lonely\\nlonely"];',
          '  "hub" [label="Hub\\nhub"];',
          '  "source" [label="Source\\nsource"];',
          '  "reader" [label="Reader\\nreader"];',
          "",
          '  "source" -> "hub";',
          `  "${LONG}" -> "hub";`,
          '  "hub" -> "reader";',
          "}",
        ].join("\n"),
      );
    });

    it("shortens a long id in a label and keeps a short one whole", () => {
      const map = formatSpaceMap(
        new Map([[LONG, { name: "Long", readingFrom: [], readBy: [] }]]),
        MapFormat.ASCII,
      );

      expect(map).toContain(`📦 Long [${LONG_SHORT}]`);
      expect(formatSpaceMap(connections, MapFormat.ASCII)).toContain(
        "📦 Hub [hub]",
      );
    });
  });

  describe("formatViewTree()", () => {
    it("returns the tree of element names and text, with branch marks", () => {
      const view = vnode("div", [
        vnode("h1", ["Title"]),
        vnode("ul", [vnode("li", ["one"]), vnode("li", [2])]),
      ]);

      expect(formatViewTree(view)).toBe(
        [
          "└─ div",
          "   ├─ h1",
          "   │  └─ Title",
          "   └─ ul",
          "      ├─ li",
          "      │  └─ one",
          "      └─ li",
          "         └─ 2",
        ].join("\n"),
      );
    });

    it("follows a node wrapped in `[UI]`", () => {
      const view = { [UI]: { [UI]: vnode("section", []) } };

      expect(formatViewTree(view)).toBe("└─ section");
    });

    it("returns a node with no children list as its name alone", () => {
      expect(formatViewTree({ type: "vnode", name: "br" })).toBe("└─ br");
    });

    it("returns a cycle of `[UI]` wrappers as text rather than following it", () => {
      const view: Record<PropertyKey, unknown> = {};
      view[UI] = view;

      expect(formatViewTree(view)).toBe("└─ [object Object]");
    });
  });

  describe("renderPieceInspection()", () => {
    const inspection = (
      source: PieceInspection["source"],
      result: PieceInspection["result"],
    ): PieceInspection => ({
      id: "fid1:inspected",
      source,
      result,
      cachedResultFields: [],
      readingFrom: [],
      readBy: [],
    });

    it("replaces nested values with type descriptors and drops `$` keys under `summary`", () => {
      const output = renderPieceInspection(
        inspection(
          {
            title: "Kept",
            count: 3,
            none: null,
            $internal: "dropped",
            list: [1, 2],
            nested: { a: 1 },
          },
          ["a", "b", "c"],
        ),
        true,
      );

      expect(output).toContain(safeStringify({
        title: "Kept",
        count: 3,
        none: null,
        list: "[Array(2)]",
        nested: "[Object]",
      }));
      expect(output).not.toContain("dropped");
      expect(output).toContain(`--- Result ---\n"[Array(3)]"`);
    });

    it("renders a scalar result as it stands under `summary`", () => {
      const output = renderPieceInspection(inspection("raw", 42), true);

      expect(output).toContain('--- Source (Inputs) ---\n"raw"');
      expect(output).toContain("--- Result ---\n42");
    });

    it("renders an array result whole without `summary`", () => {
      const output = renderPieceInspection(
        inspection({ title: "Full" }, [[1, 2]]),
        false,
      );

      expect(output).toContain(`--- Result ---\n${safeStringify([[1, 2]])}`);
    });
  });
});
