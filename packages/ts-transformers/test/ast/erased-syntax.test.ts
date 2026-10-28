import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import { isErasedAtEmit } from "../../src/ast/erased-syntax.ts";

/** The first node in `source`, depth first, that `matches` accepts. */
function findNode(
  source: string,
  matches: (node: ts.Node) => boolean,
): ts.Node {
  const sourceFile = ts.createSourceFile(
    "/test.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (matches(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`no matching node in: ${source}`);
  return found;
}

function heritageExpression(
  source: string,
  token: ts.SyntaxKind.ExtendsKeyword | ts.SyntaxKind.ImplementsKeyword,
): ts.Node {
  return findNode(
    source,
    (node) =>
      ts.isExpressionWithTypeArguments(node) &&
      ts.isHeritageClause(node.parent) && node.parent.token === token,
  );
}

describe("isErasedAtEmit()", () => {
  describe("types", () => {
    it("returns `true` for a type annotation", () => {
      const node = findNode("let x: Box<string>;", ts.isTypeReferenceNode);
      expect(isErasedAtEmit(node)).toBe(true);
    });

    it("returns `true` for the function type in a cast", () => {
      const node = findNode(
        "(value as { set: (next: string) => void }).set('x');",
        ts.isFunctionTypeNode,
      );
      expect(isErasedAtEmit(node)).toBe(true);
    });

    it("returns `true` for a `typeof` query", () => {
      const node = findNode(
        "let copy: typeof view = view;",
        ts.isTypeQueryNode,
      );
      expect(isErasedAtEmit(node)).toBe(true);
    });

    it("returns `false` for the cast expression itself", () => {
      const node = findNode("(value as Box).set('x');", ts.isAsExpression);
      expect(isErasedAtEmit(node)).toBe(false);
    });
  });

  describe("declarations", () => {
    it("returns `true` for an interface declaration", () => {
      const node = findNode(
        "interface Setter { set(next: string): void; }",
        ts.isInterfaceDeclaration,
      );
      expect(isErasedAtEmit(node)).toBe(true);
    });

    it("returns `true` for a type alias declaration", () => {
      const node = findNode(
        "type Setter = { set(next: string): void };",
        ts.isTypeAliasDeclaration,
      );
      expect(isErasedAtEmit(node)).toBe(true);
    });

    it("returns `true` for a `const enum` and `false` for a regular `enum`", () => {
      const constEnum = findNode(
        "const enum Mode { Alpha = 'alpha' }",
        ts.isEnumDeclaration,
      );
      const regularEnum = findNode(
        "enum Kind { Beta = 'beta' }",
        ts.isEnumDeclaration,
      );
      expect(isErasedAtEmit(constEnum)).toBe(true);
      expect(isErasedAtEmit(regularEnum)).toBe(false);
    });

    it("returns `true` for a class's index signature", () => {
      const node = findNode(
        "class Bag { [key: string]: number; }",
        ts.isIndexSignatureDeclaration,
      );
      expect(isErasedAtEmit(node)).toBe(true);
    });

    it("returns `true` for an overload signature and `false` for its implementation", () => {
      const source =
        "function f(next: string): void; function f(next: unknown) {}";
      const overload = findNode(
        source,
        (node) => ts.isFunctionDeclaration(node) && node.body === undefined,
      );
      const implementation = findNode(
        source,
        (node) => ts.isFunctionDeclaration(node) && node.body !== undefined,
      );
      expect(isErasedAtEmit(overload)).toBe(true);
      expect(isErasedAtEmit(implementation)).toBe(false);
    });

    it("returns `true` for an abstract method and an abstract accessor", () => {
      const source =
        "abstract class A { abstract set(next: string): void; abstract set value(next: string); }";
      const method = findNode(source, ts.isMethodDeclaration);
      const accessor = findNode(source, ts.isSetAccessorDeclaration);
      expect(isErasedAtEmit(method)).toBe(true);
      expect(isErasedAtEmit(accessor)).toBe(true);
    });

    it("returns `false` for a method, an accessor and a constructor that have bodies", () => {
      const source =
        "class A { constructor() {} set(next: string) {} set value(next: string) {} }";
      expect(isErasedAtEmit(findNode(source, ts.isConstructorDeclaration)))
        .toBe(false);
      expect(isErasedAtEmit(findNode(source, ts.isMethodDeclaration)))
        .toBe(false);
      expect(isErasedAtEmit(findNode(source, ts.isSetAccessorDeclaration)))
        .toBe(false);
    });
  });

  describe("expressions with type arguments", () => {
    it("returns `true` for an `implements` clause", () => {
      const node = heritageExpression(
        "class Label implements Tagged<string> {}",
        ts.SyntaxKind.ImplementsKeyword,
      );
      expect(isErasedAtEmit(node)).toBe(true);
    });

    it("returns `true` for an interface's `extends` clause", () => {
      const node = heritageExpression(
        "interface Local extends Tagged<string> {}",
        ts.SyntaxKind.ExtendsKeyword,
      );
      expect(isErasedAtEmit(node)).toBe(true);
    });

    it("returns `false` for a class declaration's `extends` expression", () => {
      const node = heritageExpression(
        "class Named extends labeledBase(title)<string> {}",
        ts.SyntaxKind.ExtendsKeyword,
      );
      expect(isErasedAtEmit(node)).toBe(false);
    });

    it("returns `false` for a class expression's `extends` expression", () => {
      const node = heritageExpression(
        "const Named = class extends Base<string> {};",
        ts.SyntaxKind.ExtendsKeyword,
      );
      expect(isErasedAtEmit(node)).toBe(false);
    });

    it("returns `false` for an instantiation expression and `true` for its type argument", () => {
      const instantiation = findNode(
        "const format = formatterFor(title)<string>;",
        ts.isExpressionWithTypeArguments,
      );
      expect(isErasedAtEmit(instantiation)).toBe(false);
      const [typeArgument] =
        (instantiation as ts.ExpressionWithTypeArguments).typeArguments ?? [];
      expect(typeArgument && isErasedAtEmit(typeArgument)).toBe(true);
    });
  });
});
