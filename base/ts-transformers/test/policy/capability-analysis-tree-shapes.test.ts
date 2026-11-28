/**
 * Trees the analysis is handed that a type-checked source file does not
 * produce: syntax the parser accepts and the checker rejects, and a callback
 * a rewrite rebuilt, in which a synthesized node's parent link stops short.
 */

import { expect } from "@std/expect";
import ts from "typescript";

import { setParentPointers } from "../../src/ast/utils.ts";
import { analyzeFunctionCapabilities } from "../../src/policy/mod.ts";
import { describe, it } from "@commonfabric/test-support/test";

const f = ts.factory;

/** The first arrow function in `source`, parsed with its parent links. */
function parseArrow(source: string): ts.ArrowFunction {
  const file = ts.createSourceFile(
    "/test.ts",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  let arrow: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (arrow) return;
    if (ts.isArrowFunction(node)) {
      arrow = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!arrow) throw new Error("Expected an arrow function in test source.");
  return arrow;
}

/**
 * The first arrow function in `source` as a rewrite rebuilds it: a new
 * arrow and block, with `synthesized` standing where the body has the
 * statement `__synthesized__;`. Without `linked`, the rebuilt nodes have no
 * parent links but those `synthesized` was built with, as after a rewrite
 * that links only what it builds; with it, every missing link is filled in.
 */
function rebuildArrow(
  source: string,
  synthesized: ts.Statement,
  linked: boolean,
): ts.ArrowFunction {
  const arrow = parseArrow(source);
  if (!ts.isBlock(arrow.body)) throw new Error("Expected a block body.");
  const statements = arrow.body.statements.map((statement) =>
    ts.isExpressionStatement(statement) &&
      ts.isIdentifier(statement.expression) &&
      statement.expression.text === "__synthesized__"
      ? synthesized
      : statement
  );
  const rebuilt = f.updateArrowFunction(
    arrow,
    arrow.modifiers,
    arrow.typeParameters,
    arrow.parameters,
    arrow.type,
    arrow.equalsGreaterThanToken,
    f.updateBlock(arrow.body, statements),
  );
  if (linked) setParentPointers(rebuilt);
  return rebuilt;
}

/** `node`, with links from each node below it up to its parent. */
function linkedBelow<T extends ts.Node>(node: T): T {
  setParentPointers(node);
  return node;
}

function summaryOf(fn: ts.ArrowFunction, name: string) {
  const summary = analyzeFunctionCapabilities(fn).params.find((param) =>
    param.name === name
  );
  if (!summary) throw new Error(`Missing parameter summary for '${name}'.`);
  return {
    readPaths: summary.readPaths.map((path) => path.join(".")),
    escapedPaths: (summary.escapedPaths ?? []).map((path) => path.join(".")),
    wildcard: summary.wildcard,
  };
}

describe("analyzeFunctionCapabilities()", () => {
  describe("syntax the checker rejects", () => {
    it("reads the whole value a bigint key destructures", () => {
      const bigint = summaryOf(
        parseArrow(`(input) => { const { 1n: x } = input; return x; }`),
        "input",
      );
      expect(bigint.wildcard).toBe(true);
      expect(bigint.readPaths).toEqual([]);

      const numeric = summaryOf(
        parseArrow(`(input) => { const { 1: x } = input; return x; }`),
        "input",
      );
      expect(numeric.wildcard).toBe(false);
      expect(numeric.readPaths).toEqual(["1"]);
    });

    it("lets a value escape into an assignment pattern holding a method", () => {
      const withMethod = summaryOf(
        parseArrow(
          `(input) => { let a; ({ a, m() {} } = input); return a; }`,
        ),
        "input",
      );
      expect(withMethod.readPaths).toEqual(["a"]);
      expect(withMethod.escapedPaths).toEqual([""]);

      const plain = summaryOf(
        parseArrow(`(input) => { let a; ({ a } = input); return a; }`),
        "input",
      );
      expect(plain.readPaths).toEqual(["a"]);
      expect(plain.escapedPaths).toEqual([]);
    });
  });

  describe("a synthesized node whose parent link stops short", () => {
    it("takes an assignment with no function above it to a local", () => {
      const source = `let outer; const fn = (input) => { __synthesized__; };`;
      const assignment = () =>
        f.createExpressionStatement(linkedBelow(
          f.createAssignment(
            f.createIdentifier("outer"),
            f.createIdentifier("input"),
          ),
        ));

      expect(
        summaryOf(rebuildArrow(source, assignment(), true), "input")
          .escapedPaths,
      ).toEqual([""]);
      expect(
        summaryOf(rebuildArrow(source, assignment(), false), "input")
          .escapedPaths,
      ).toEqual([]);
    });

    it("reads the result of a writer call it cannot place", () => {
      const source = `(input) => {
        const copy = [...input.items];
        __synthesized__;
        Array.isArray(copy);
      }`;
      const splice = () =>
        f.createExpressionStatement(linkedBelow(
          f.createCallExpression(
            f.createPropertyAccessExpression(
              f.createIdentifier("copy"),
              "splice",
            ),
            undefined,
            [f.createNumericLiteral(0), f.createNumericLiteral(1)],
          ),
        ));

      expect(
        summaryOf(rebuildArrow(source, splice(), true), "input").escapedPaths,
      ).toEqual([]);
      expect(
        summaryOf(rebuildArrow(source, splice(), false), "input").escapedPaths,
      ).toEqual(["items.0"]);
    });

    it("reads the elements of a local used where it cannot be placed", () => {
      const source = `(input) => {
        const copy = [...input.items];
        __synthesized__;
      }`;
      const isArray = () =>
        f.createExpressionStatement(
          f.createCallExpression(
            f.createPropertyAccessExpression(
              f.createIdentifier("Array"),
              "isArray",
            ),
            undefined,
            [f.createIdentifier("copy")],
          ),
        );

      expect(
        summaryOf(rebuildArrow(source, isArray(), true), "input").escapedPaths,
      ).toEqual([]);
      expect(
        summaryOf(rebuildArrow(source, isArray(), false), "input")
          .escapedPaths,
      ).toEqual(["items.0"]);
    });

    it("reads an element a negation it cannot place tests", () => {
      const source = `(input) => {
        const hit = input.items.find((item) => item.on);
        __synthesized__;
        return hit.name;
      }`;
      const guard = () =>
        f.createIfStatement(
          linkedBelow(
            f.createPrefixUnaryExpression(
              ts.SyntaxKind.ExclamationToken,
              f.createIdentifier("hit"),
            ),
          ),
          f.createReturnStatement(f.createNumericLiteral(0)),
        );

      expect(summaryOf(rebuildArrow(source, guard(), true), "input").readPaths)
        .toEqual(["items", "items.0.name"]);
      expect(summaryOf(rebuildArrow(source, guard(), false), "input").readPaths)
        .toEqual(["items", "items.0", "items.0.name"]);
    });
  });
});
