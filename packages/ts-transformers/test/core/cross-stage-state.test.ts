import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { CrossStageState } from "../../src/core/mod.ts";

describe("CrossStageState", () => {
  describe("instance members", () => {
    describe("printedFrom()", () => {
      const printedType = { flags: ts.TypeFlags.Object } as ts.Type;
      const printedNode = () =>
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);

      it("returns the type a node was recorded as printed from", () => {
        const state = new CrossStageState();
        const node = printedNode();
        state.recordPrintedFrom(node, printedType);

        expect(state.printedFrom(node)).toBe(printedType);
      });

      it("returns `undefined` for a node recorded as nothing", () => {
        const state = new CrossStageState();

        expect(state.printedFrom(printedNode())).toBeUndefined();
      });

      it("returns `undefined` for a node whose original was printed", () => {
        const state = new CrossStageState();
        const node = printedNode();
        state.recordPrintedFrom(node, printedType);
        const derived = ts.setOriginalNode(printedNode(), node);

        expect(state.printedFrom(derived)).toBeUndefined();
      });
    });
  });
});
