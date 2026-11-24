import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import ts from "typescript";

import {
  isTransparentWrapper,
  outermostTransparentWrapper,
  unwrapExpression,
  unwrapTransparentWrapperOnce,
} from "../../src/utils/expression.ts";

const numberType = () =>
  ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);

/** One constructor per transparent wrapper spelling, keyed by its syntax. */
const WRAPPERS: Readonly<
  Record<string, (inner: ts.Expression) => ts.Expression>
> = {
  "(x)": (inner) => ts.factory.createParenthesizedExpression(inner),
  "x as T": (inner) => ts.factory.createAsExpression(inner, numberType()),
  "<T>x": (inner) => ts.factory.createTypeAssertion(numberType(), inner),
  "x satisfies T": (inner) =>
    ts.factory.createSatisfiesExpression(inner, numberType()),
  "x!": (inner) => ts.factory.createNonNullExpression(inner),
  "partially emitted": (inner) =>
    ts.factory.createPartiallyEmittedExpression(inner),
};

/**
 * Parses `code` with parent pointers set and returns the first identifier named
 * `x`, whose enclosing wrappers each test then walks out of.
 */
const identifierX = (code: string): ts.Identifier => {
  const sourceFile = ts.createSourceFile(
    "t.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
  );
  let found: ts.Identifier | undefined;
  const walk = (candidate: ts.Node) => {
    if (ts.isIdentifier(candidate) && candidate.text === "x") {
      found ??= candidate;
    }
    ts.forEachChild(candidate, walk);
  };
  walk(sourceFile);
  if (!found) throw new Error(`no identifier \`x\` in: ${code}`);
  return found;
};

describe("expression", () => {
  describe("isTransparentWrapper()", () => {
    for (const [syntax, wrap] of Object.entries(WRAPPERS)) {
      it(`returns \`true\` for \`${syntax}\``, () => {
        expect(isTransparentWrapper(wrap(ts.factory.createNumericLiteral("1"))))
          .toBe(true);
      });
    }

    it("returns `false` for an expression that is not a wrapper", () => {
      expect(isTransparentWrapper(ts.factory.createNumericLiteral("1")))
        .toBe(false);
    });
  });

  describe("unwrapTransparentWrapperOnce()", () => {
    for (const [syntax, wrap] of Object.entries(WRAPPERS)) {
      it(`returns the expression wrapped by \`${syntax}\``, () => {
        const literal = ts.factory.createNumericLiteral("1");

        expect(unwrapTransparentWrapperOnce(wrap(literal))).toBe(literal);
      });
    }

    it("removes a single wrapper, leaving the rest of the chain in place", () => {
      const literal = ts.factory.createNumericLiteral("1");
      const inner = ts.factory.createParenthesizedExpression(literal);
      const outer = ts.factory.createNonNullExpression(inner);

      expect(unwrapTransparentWrapperOnce(outer)).toBe(inner);
    });

    it("returns `undefined` for an expression that is not a wrapper", () => {
      expect(unwrapTransparentWrapperOnce(ts.factory.createNumericLiteral("1")))
        .toBe(undefined);
    });
  });

  describe("outermostTransparentWrapper()", () => {
    it("returns the expression itself when no wrapper encloses it", () => {
      const x = identifierX("const a = x;");

      expect(outermostTransparentWrapper(x)).toBe(x);
    });

    it("returns the outermost wrapper of an enclosing chain", () => {
      const x = identifierX("const a = ((x as T)!);");
      // The whole initializer is the outermost thing denoting x's value.
      let initializer: ts.Node = x;
      while (!ts.isVariableDeclaration(initializer.parent)) {
        initializer = initializer.parent;
      }

      expect(ts.isParenthesizedExpression(initializer)).toBe(true);
      expect(outermostTransparentWrapper(x)).toBe(initializer);
    });

    it("stops at a parent that is not a transparent wrapper", () => {
      const x = identifierX("const a = (x).y;");
      const paren = x.parent;

      expect(ts.isPropertyAccessExpression(paren.parent)).toBe(true);
      expect(outermostTransparentWrapper(x)).toBe(paren);
    });
  });

  describe("unwrapExpression()", () => {
    it("removes every wrapper spelling from a nested chain", () => {
      const literal = ts.factory.createNumericLiteral("1");
      const wrapped = Object.values(WRAPPERS).reduce<ts.Expression>(
        (inner, wrap) => wrap(inner),
        literal,
      );

      expect(unwrapExpression(wrapped)).toBe(literal);
    });

    it("returns the expression itself when it carries no wrapper", () => {
      const literal = ts.factory.createNumericLiteral("1");

      expect(unwrapExpression(literal)).toBe(literal);
    });
  });
});
