import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import {
  buildCapturePropertyAssignments,
  buildHierarchicalParamsValue,
  createCaptureTreeNode,
} from "../../src/utils/capture-tree.ts";

describe("capture-tree", () => {
  const factory = ts.factory;
  const sourceFile = ts.createSourceFile(
    "capture.ts",
    "",
    ts.ScriptTarget.ESNext,
  );
  const printer = ts.createPrinter();

  const evaluate = (expression: ts.Expression, value: object): object => {
    const emitted = printer.printNode(
      ts.EmitHint.Expression,
      expression,
      sourceFile,
    );
    return new Function("source", `return (${emitted});`)(value);
  };

  it("captures a nested prototype-named key as an own property", () => {
    const payload = { value: 7 };
    const source = { ["__proto__"]: payload };
    const root = createCaptureTreeNode([]);
    const child = createCaptureTreeNode(["__proto__"]);
    child.expression = factory.createPropertyAccessExpression(
      factory.createIdentifier("source"),
      "__proto__",
    );
    root.properties.set("__proto__", child);

    const value = evaluate(
      buildHierarchicalParamsValue(root, "source", factory),
      source,
    );

    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toBe(
      payload,
    );
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });

  it("captures a prototype-named root binding as an own property", () => {
    const payload = { value: 7 };
    const root = createCaptureTreeNode([]);
    root.expression = factory.createIdentifier("source");
    const expression = factory.createObjectLiteralExpression(
      buildCapturePropertyAssignments(
        [["source", root]],
        factory,
        new Map([["source", "__proto__"]]),
      ),
    );

    const value = evaluate(expression, payload);

    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toBe(
      payload,
    );
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });
});
