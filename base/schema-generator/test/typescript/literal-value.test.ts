import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { extractLiteralValue } from "../../src/typescript/literal-value.ts";
import { createTestProgram } from "../utils.ts";

/** The literal value read from the initializer of `const value` in `source`. */
async function literalOf(
  source: string,
): Promise<{ value: unknown } | undefined> {
  const { checker, sourceFile } = await createTestProgram(source);
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === "value"
    ) {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!initializer) throw new Error("`const value` has no initializer");
  return extractLiteralValue(initializer, checker);
}

describe("literal-value", () => {
  describe("extractLiteralValue()", () => {
    it("returns an object literal of literal members", async () => {
      expect(await literalOf(`const value = { a: 1, b: "x" };`)).toEqual({
        value: { a: 1, b: "x" },
      });
    });

    it("returns `undefined` for an object literal holding a spread", async () => {
      expect(
        await literalOf(`const base = { a: 1 }; const value = { ...base };`),
      ).toBeUndefined();
    });

    it("returns `undefined` for an object literal holding a method", async () => {
      expect(await literalOf(`const value = { a: 1, f() { return 1; } };`))
        .toBeUndefined();
    });

    it("returns a const an identifier names", async () => {
      expect(await literalOf(`const named = "x"; const value = named;`))
        .toEqual({ value: "x" });
    });

    it("returns `undefined` for an identifier that names nothing", async () => {
      // The program does not compile, and the checker resolves no symbol for
      // the name.

      expect(await literalOf(`const value = missing;`)).toBeUndefined();
    });
  });
});
