import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { CrossStageState } from "../../src/core/mod.ts";

describe("CrossStageState", () => {
  describe("instance members", () => {
    describe("isPrintedFrom()", () => {
      const printedType = { flags: ts.TypeFlags.Object } as ts.Type;
      const otherType = { flags: ts.TypeFlags.Object } as ts.Type;
      const printedNode = () =>
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);

      it("returns `true` for the type a node was recorded as printed from", () => {
        const state = new CrossStageState();
        const node = printedNode();
        state.recordPrintedFrom(node, printedType);

        expect(state.isPrintedFrom(node, printedType)).toBe(true);
      });

      it("returns `false` for a type other than the one a node was printed from", () => {
        const state = new CrossStageState();
        const node = printedNode();
        state.recordPrintedFrom(node, printedType);

        expect(state.isPrintedFrom(node, otherType)).toBe(false);
      });

      it("returns `false` for a node whose original was printed", () => {
        const state = new CrossStageState();
        const node = printedNode();
        state.recordPrintedFrom(node, printedType);
        const derived = ts.setOriginalNode(printedNode(), node);

        expect(state.isPrintedFrom(derived, printedType)).toBe(false);
      });
    });
  });
});
