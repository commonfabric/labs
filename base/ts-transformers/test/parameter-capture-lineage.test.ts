import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { preserveSourceMapRange } from "../src/ast/utils.ts";
import { isDeclaredWithinFunction } from "../src/ast/scope-analysis.ts";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

describe("parameter capture lineage", () => {
  it("keeps a cloned parameter local without conflating same-named bindings", () => {
    const source = ts.createSourceFile(
      "input.ts",
      "const first = (row: string) => row; const second = (row: string) => row;",
      ts.ScriptTarget.Latest,
      true,
    );
    const callbacks: ts.ArrowFunction[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isArrowFunction(node)) callbacks.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    const [first, second] = callbacks;
    const parameter = first.parameters[0];
    const clonedParameter = ts.factory.updateParameterDeclaration(
      parameter,
      parameter.modifiers,
      parameter.dotDotDotToken,
      parameter.name,
      parameter.questionToken,
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      parameter.initializer,
    );
    const cloned = ts.factory.updateArrowFunction(
      first,
      first.modifiers,
      first.typeParameters,
      [clonedParameter],
      first.type,
      first.equalsGreaterThanToken,
      first.body,
    );
    expect(clonedParameter).not.toBe(parameter);
    expect(isDeclaredWithinFunction(parameter, cloned)).toBe(true);
    expect(isDeclaredWithinFunction(clonedParameter, first)).toBe(true);
    expect(isDeclaredWithinFunction(second.parameters[0], cloned)).toBe(false);
  });

  it("recognizes a rebuilt callback by its authored range", () => {
    const source = ts.createSourceFile(
      "input.ts",
      "const first = (row: string) => row; const second = (row: string) => row;",
      ts.ScriptTarget.Latest,
      true,
    );
    const callbacks: ts.ArrowFunction[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isArrowFunction(node)) callbacks.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    const [first, second] = callbacks;
    const rebuilt = preserveSourceMapRange(
      ts.factory.createArrowFunction(
        undefined,
        undefined,
        [ts.factory.createParameterDeclaration(
          undefined,
          undefined,
          ts.factory.createObjectBindingPattern([
            ts.factory.createBindingElement(undefined, "element", "row"),
          ]),
        )],
        undefined,
        undefined,
        first.body,
      ),
      first,
    );
    expect(ts.getOriginalNode(rebuilt)).toBe(rebuilt);
    expect(isDeclaredWithinFunction(first.parameters[0], rebuilt)).toBe(true);
    expect(isDeclaredWithinFunction(second.parameters[0], rebuilt)).toBe(false);
  });

  it("separates nested bindings and equal ranges in different source files", () => {
    const text = "const outer = (row: string) => (row: string) => row;";
    const sources = ["first.ts", "second.ts"].map((name) =>
      ts.createSourceFile(
        name,
        text,
        ts.ScriptTarget.Latest,
        true,
      )
    );
    const callbacks = sources.map((source) => {
      const found: ts.ArrowFunction[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isArrowFunction(node)) found.push(node);
        ts.forEachChild(node, visit);
      };
      visit(source);
      return found;
    });
    const [outer, inner] = callbacks[0];
    expect(isDeclaredWithinFunction(inner.parameters[0], outer)).toBe(false);
    expect(isDeclaredWithinFunction(outer.parameters[0], inner)).toBe(false);
    expect(isDeclaredWithinFunction(callbacks[1][0].parameters[0], outer)).toBe(
      false,
    );
  });

  it("keeps inner lookup-map parameters out of the outer capture object", async () => {
    const output = await transformSource(
      `
      import { pattern, GroupIndex } from "commonfabric";
      export default pattern<{ groups: GroupIndex<string, { title: string }> }>(({ groups }) => ({
        enumerated: groups.keys().map(key => groups.lookup(key).map(row => row.title)),
      }));
    `,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    const root = parseModule(output);
    const maps = callsNamed(root, "mapWithPattern");
    expect(maps).toHaveLength(2);
    expect(maps.every((call) => call.arguments.length === 1)).toBe(true);
    const captureNames = callsNamed(root, "curry").map((call) => {
      const captures = call.arguments[0];
      if (!captures || !ts.isObjectLiteralExpression(captures)) {
        throw new Error("Expected a curried capture object");
      }
      return captures.properties.map((property) => {
        if (!property.name || !ts.isIdentifier(property.name)) {
          throw new Error("Expected a named capture");
        }
        return property.name.text;
      });
    });
    expect(captureNames.flat()).not.toContain("row");
    expect(captureNames.flat()).toContain("groups");
  });
});
