import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { unionNodeMembersInOrder } from "../../src/typescript/source-order.ts";

describe("source-order", () => {
  describe("unionNodeMembersInOrder()", () => {
    const f = ts.factory;
    const bigint = (text: string) =>
      f.createLiteralTypeNode(f.createBigIntLiteral(text));
    const negated = (text: string) =>
      f.createLiteralTypeNode(
        f.createPrefixUnaryExpression(
          ts.SyntaxKind.MinusToken,
          f.createBigIntLiteral(text),
        ),
      );
    const texts = (nodes: readonly ts.TypeNode[]) =>
      nodes.map((node) => {
        const literal = (node as ts.LiteralTypeNode).literal;
        return ts.isPrefixUnaryExpression(literal)
          ? `-${(literal.operand as ts.BigIntLiteral).text}`
          : (literal as ts.BigIntLiteral).text;
      });

    it("lists a built union's bigint members by value", () => {
      const union = f.createUnionTypeNode([
        bigint("10n"),
        bigint("2n"),
        negated("3n"),
      ]);

      expect(texts(unionNodeMembersInOrder(union))).toEqual([
        "-3n",
        "2n",
        "10n",
      ]);
    });

    it("lists members that differ by their type operator alone in one order whatever order they came in", () => {
      const object = () =>
        f.createTypeLiteralNode([
          f.createPropertySignature(
            undefined,
            "a",
            undefined,
            f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
          ),
        ]);
      const keyOf = f.createTypeOperatorNode(
        ts.SyntaxKind.KeyOfKeyword,
        object(),
      );
      const readOnly = f.createTypeOperatorNode(
        ts.SyntaxKind.ReadonlyKeyword,
        object(),
      );
      const operators = (members: ts.TypeNode[]) =>
        unionNodeMembersInOrder(f.createUnionTypeNode(members)).map((node) =>
          (node as ts.TypeOperatorNode).operator
        );

      expect(operators([keyOf, readOnly])).toEqual(
        operators([readOnly, keyOf]),
      );
    });
  });
});
