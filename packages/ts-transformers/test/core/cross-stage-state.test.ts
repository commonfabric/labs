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

    describe("printedWithin()", () => {
      const printedType = { flags: ts.TypeFlags.Object } as ts.Type;
      const f = ts.factory;

      it("returns the root of the print a node was built below", () => {
        const state = new CrossStageState();
        const root = f.createArrayTypeNode(
          f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        );
        state.recordPrintedFrom(root, printedType);

        expect(state.printedWithin(root.elementType)).toBe(root);
      });

      it("returns `undefined` for the root of a print", () => {
        const state = new CrossStageState();
        const root = f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
        state.recordPrintedFrom(root, printedType);

        expect(state.printedWithin(root)).toBeUndefined();
      });

      it("returns `undefined` for a node a print reuses from the source", () => {
        const state = new CrossStageState();
        const source = ts.createSourceFile(
          "authored.ts",
          "type Authored = string;",
          ts.ScriptTarget.Latest,
          true,
        );
        const authored = (source.statements[0] as ts.TypeAliasDeclaration).type;
        const root = f.createArrayTypeNode(authored);
        state.recordPrintedFrom(root, printedType);

        expect(state.printedWithin(authored)).toBeUndefined();
      });
    });

    describe("printPieceIn()", () => {
      const printedType = { flags: ts.TypeFlags.Object } as ts.Type;
      const f = ts.factory;
      const printedArray = (state: CrossStageState) => {
        const root = f.createArrayTypeNode(
          f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        );
        state.recordPrintedFrom(root, printedType);
        return root;
      };
      const literalHolding = (type: ts.TypeNode) =>
        f.createTypeLiteralNode([
          f.createPropertySignature(undefined, "held", undefined, type),
        ]);

      it("returns a node built below a print that is held outside it", () => {
        const state = new CrossStageState();
        const root = printedArray(state);

        expect(state.printPieceIn(literalHolding(root.elementType)))
          .toBe(root.elementType);
      });

      it("returns `undefined` for a print held whole", () => {
        const state = new CrossStageState();
        const root = printedArray(state);

        expect(state.printPieceIn(literalHolding(root))).toBeUndefined();
      });

      it("returns `undefined` for a node holding no print", () => {
        const state = new CrossStageState();

        expect(
          state.printPieceIn(
            literalHolding(
              f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
            ),
          ),
        ).toBeUndefined();
      });
    });
  });
});
