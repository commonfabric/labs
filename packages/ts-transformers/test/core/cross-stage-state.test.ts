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
      const printedMembers = (state: CrossStageState) => {
        const root = f.createTypeLiteralNode([
          f.createPropertySignature(
            undefined,
            "name",
            undefined,
            f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
          ),
        ]);
        state.recordPrintedFrom(root, printedType);
        return root.members as ts.NodeArray<ts.PropertySignature>;
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

      it("returns a literal built below a print that a node outside it holds", () => {
        const state = new CrossStageState();
        const root = f.createLiteralTypeNode(f.createStringLiteral("a"));
        state.recordPrintedFrom(root, printedType);
        const rebuilt = f.createLiteralTypeNode(
          root.literal as ts.StringLiteral,
        );

        expect(state.printPieceIn(literalHolding(rebuilt))).toBe(root.literal);
      });

      it("returns a name built below a print that a node outside it holds", () => {
        const state = new CrossStageState();
        const [member] = printedMembers(state);
        const rebuilt = f.createTypeLiteralNode([
          f.createPropertySignature(
            undefined,
            member!.name,
            undefined,
            f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
          ),
        ]);

        expect(state.printPieceIn(rebuilt)).toBe(member!.name);
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

    describe("recordSchemaHint()", () => {
      const node = () =>
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);

      it("keeps the hints of other kinds a node already has", () => {
        const state = new CrossStageState();
        const hinted = node();
        state.recordSchemaHint(hinted, { items: false });
        state.recordSchemaHint(hinted, {
          cfcUiContract: { helper: "UiAction", action: "save" },
        });

        expect(state.lookupSchemaHint(hinted)).toEqual({
          items: false,
          cfcUiContract: { helper: "UiAction", action: "save" },
        });
      });
    });

    describe("recordNarrowedFrom()", () => {
      const f = ts.factory;
      const valueType = { flags: ts.TypeFlags.Object } as ts.Type;
      const partType = { flags: ts.TypeFlags.Object } as ts.Type;
      const node = () => f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);

      it("records the value a node narrows", () => {
        const state = new CrossStageState();
        const narrowed = node();
        state.recordNarrowedFrom(narrowed, { type: valueType });

        expect(state.lookupSchemaHint(narrowed)?.narrowedFrom).toEqual({
          type: valueType,
        });
      });

      it("keeps the hints of other kinds the node already has", () => {
        const state = new CrossStageState();
        const narrowed = node();
        state.recordSchemaHint(narrowed, { items: false });
        state.recordNarrowedFrom(narrowed, { type: valueType });

        expect(state.lookupSchemaHint(narrowed)).toEqual({
          items: false,
          narrowedFrom: { type: valueType },
        });
      });

      it("records a narrowed node's value for a node narrowing it", () => {
        const state = new CrossStageState();
        const first = node();
        const second = node();
        state.recordNarrowedFrom(first, { type: valueType });
        state.recordNarrowedFrom(second, { type: partType, typeNode: first });

        expect(state.lookupSchemaHint(second)?.narrowedFrom).toEqual({
          type: valueType,
        });
      });

      it("leaves the node's original without a hint", () => {
        const state = new CrossStageState();
        const original = node();
        const narrowed = ts.setOriginalNode(node(), original);
        state.recordNarrowedFrom(narrowed, { type: valueType });

        expect(state.schemaHints.get(original)).toBeUndefined();
      });
    });

    describe("narrowedFrom()", () => {
      const f = ts.factory;
      const valueType = { flags: ts.TypeFlags.Object } as ts.Type;
      const node = () => f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);

      it("returns the value a node was recorded as narrowing", () => {
        const state = new CrossStageState();
        const narrowed = node();
        state.recordNarrowedFrom(narrowed, { type: valueType });

        expect(state.narrowedFrom(narrowed)).toEqual({ type: valueType });
      });

      it("returns `undefined` for a node recorded as narrowing nothing", () => {
        const state = new CrossStageState();
        const hinted = node();
        state.recordSchemaHint(hinted, { items: false });

        expect(state.narrowedFrom(hinted)).toBeUndefined();
      });
    });
  });
});
